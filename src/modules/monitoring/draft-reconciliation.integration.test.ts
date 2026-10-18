import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { capturing, capturingTypes } from '@/shared/testing/events';
import {
  archiveService,
  createCheckResultPartitions,
  createMonitor,
  createService,
  failureOutcome,
  recordCheckOutcome,
  setMonitorCheckState,
  transitionIncident,
  updateMonitor,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import { runWorkerPass } from '@/worker';
import { refreshUptimeRollupsCommand } from './commands/refresh-uptime-rollups/refresh-uptime-rollups.handler';
import { listMonitorsAtThresholdQuery } from './queries/list-monitors-at-threshold/list-monitors-at-threshold.handler';

/**
 * Story 5.16: reconcile missed drafts each pass. Scoped passes only; reads
 * incidents with SQL, as the monitoring module itself must not.
 */

const tag = `drr-${randomBytes(4).toString('hex')}`;
const DRAFT_CREATED = 'incident/draft_created';
// Module command types are strings; importing the creator would cross modules.
const CREATE_DRAFT = 'incident/draft.create_from_monitor';

type Tenant = {
  cookie: string;
  orgId: string;
  userId: string;
  serviceId: string;
};

let app: FastifyInstance;
let a: Tenant;
let b: Tenant;

type Logged = { level: string; obj: Record<string, unknown>; msg: string };
function logger() {
  const logged: Logged[] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown>, msg: string): void => {
      logged.push({ level, obj, msg });
    };
  return {
    logged,
    log: { info: at('info'), warn: at('warn'), error: at('error') } as never,
  };
}

async function pass(orgIds: string[], log: never = logger().log) {
  await runWorkerPass(app, log, { orgIds });
  await app.eventBus.drain();
}

function monitor(t: Tenant, overrides: object = {}) {
  return createMonitor(app, t.cookie, t.serviceId, {
    failureThreshold: 3,
    ...overrides,
  });
}

/** At threshold with no event: the state a lost event leaves behind. */
function atThreshold(t: Tenant, monitorId: string, episode = 1, failures = 3) {
  return setMonitorCheckState(t.orgId, monitorId, {
    consecutiveFailures: failures,
    failureEpisode: episode,
  });
}

type IncidentRow = {
  id: string;
  status: string;
  source: string;
  origin_failure_episode: number | null;
};
function incidentsOf(t: Tenant, monitorId: string) {
  return withTenantTransaction(
    t.orgId,
    ({ sql: tx }) =>
      tx<IncidentRow[]>`
        select id, status, source, origin_failure_episode from incidents
        where origin_monitor_id = ${monitorId}
        order by origin_failure_episode, id
      `,
  );
}

async function counters(t: Tenant, monitorId: string) {
  const rows = await withTenantTransaction(
    t.orgId,
    ({ sql: tx }) =>
      tx<{ failure_episode: number; consecutive_failures: number }[]>`
        select failure_episode, consecutive_failures from monitors
        where id = ${monitorId}
      `,
  );
  return rows[0];
}

function ofMonitor(events: unknown[], monitorId: string) {
  return events.filter(
    (e) =>
      (e as { payload: { originMonitorId: string } }).payload
        .originMonitorId === monitorId,
  );
}

/** A stub app: throws for the target, delegates every other action. */
function stubApp(opts: {
  query?: (orgId: string) => boolean;
  command?: (monitorId: string) => boolean;
  reconcile?: (orgId: string) => boolean;
  transition?: (orgId: string) => boolean;
  seen?: { type: string; orgId: unknown }[];
}) {
  return {
    commandBus: {
      execute(command: { type: string; payload: Record<string, unknown> }) {
        opts.seen?.push({ type: command.type, orgId: command.payload.orgId });
        if (
          command.type === 'maintenance/transition_due' &&
          opts.transition?.(command.payload.orgId as string)
        )
          throw new Error('transition refused');
        if (
          command.type === 'service/status.reconcile' &&
          opts.reconcile?.(command.payload.orgId as string)
        )
          throw new Error('reconcile refused');
        if (
          opts.command?.(command.payload.monitorId as string) &&
          command.type === CREATE_DRAFT
        )
          throw new Error('draft refused');
        return app.commandBus.execute(command as never);
      },
    },
    queryBus: {
      execute(query: { type: string; payload: Record<string, unknown> }) {
        if (
          opts.query?.(query.payload.orgId as string) &&
          query.type === listMonitorsAtThresholdQuery.type
        )
          throw new Error('query refused');
        return app.queryBus.execute(query as never);
      },
    },
  } as unknown as Parameters<typeof runWorkerPass>[0];
}

describe('Story 5.16: reconcile missed drafts', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    const make = async (label: string): Promise<Tenant> => {
      const { cookie, orgId, userId } = await signUpWithOrg(
        app,
        `${tag}-${label}`,
      );
      const serviceId = await createService(app, cookie);
      return { cookie, orgId, userId, serviceId };
    };
    a = await make('a');
    b = await make('b');
    await createCheckResultPartitions();
  });

  after(async () => {
    await app.eventBus.drain();
    for (const t of [a, b]) {
      await sql`delete from "organization" where "id" = ${t.orgId}`;
      await sql`delete from "user" where "id" = ${t.userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('the query lists only enabled, at-threshold monitors on live services', async () => {
    const archivedService = await createService(app, a.cookie);
    const hit = await monitor(a);
    await atThreshold(a, hit, 2);
    const below = await monitor(a);
    await atThreshold(a, below, 1, 2);
    const disabled = await monitor(a, { enabled: false });
    await atThreshold(a, disabled);
    const onArchived = await createMonitor(app, a.cookie, archivedService, {
      failureThreshold: 3,
    });
    await atThreshold(a, onArchived);
    await archiveService(app, a.cookie, archivedService);
    const over = await monitor(a);
    await atThreshold(a, over, 3, 5);
    const other = await monitor(b);
    await atThreshold(b, other);
    const otherBelow = await monitor(b);
    await atThreshold(b, otherBelow, 1, 2);
    const otherDisabled = await monitor(b, { enabled: false });
    await atThreshold(b, otherDisabled);
    const bArchived = await createService(app, b.cookie);
    const otherOnArchived = await createMonitor(app, b.cookie, bArchived, {
      failureThreshold: 3,
    });
    await atThreshold(b, otherOnArchived);
    await archiveService(app, b.cookie, bArchived);

    const listed = await app.queryBus.execute<
      { id: string; failureEpisode: number }[]
    >(listMonitorsAtThresholdQuery({ orgId: a.orgId }));
    const mine = listed.filter((m) =>
      [
        hit,
        over,
        below,
        disabled,
        onArchived,
        other,
        otherBelow,
        otherDisabled,
        otherOnArchived,
      ].includes(m.id),
    );
    assert.deepEqual(
      mine.map((m) => [m.id, m.failureEpisode]),
      [
        [hit, 2],
        [over, 3],
      ].sort((x, y) => (x[0] as string).localeCompare(y[0] as string)),
    );
    const ids = listed.map((m) => m.id);
    assert.deepEqual(ids, [...ids].sort());
  });

  it('opens a draft for a lost event, once', async () => {
    const id = await monitor(a);
    await atThreshold(a, id, 2);
    const firstLog = logger();
    const first = await capturing(app, DRAFT_CREATED, () =>
      pass([a.orgId], firstLog.log),
    );
    const OPENED = 'opened monitor drafts no breach event had opened';
    const warns = firstLog.logged.filter((l) => l.msg === OPENED);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].level, 'warn');
    assert.equal(warns[0].obj.orgId, a.orgId);
    assert.ok((warns[0].obj.opened as string[]).includes(id));
    const rows = await incidentsOf(a, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft');
    assert.equal(rows[0].source, 'monitoring');
    assert.equal(rows[0].origin_failure_episode, 2);
    assert.equal(ofMonitor(first.captured, id).length, 1);

    const detail = await withTenantTransaction(
      a.orgId,
      async ({ sql: tx }) => ({
        incident: (
          await tx<{ title: string }[]>`
            select title from incidents where id = ${rows[0].id}`
        )[0],
        monitor: (
          await tx<{ name: string }[]>`
            select name from monitors where id = ${id}`
        )[0],
        impacts: await tx<{ service_id: string; impact: string }[]>`
          select service_id, impact from incident_service_impacts
          where incident_id = ${rows[0].id}`,
      }),
    );
    assert.equal(
      detail.incident.title,
      `Monitor failure: ${detail.monitor.name}`,
    );
    assert.deepEqual(
      [...detail.impacts].map((r) => ({ ...r })),
      [{ service_id: a.serviceId, impact: 'critical' }],
    );

    const secondLog = logger();
    const second = await capturing(app, DRAFT_CREATED, () =>
      pass([a.orgId], secondLog.log),
    );
    assert.ok(
      !secondLog.logged.some(
        (l) => l.msg === OPENED && (l.obj.opened as string[]).includes(id),
      ),
    );
    assert.equal((await incidentsOf(a, id)).length, 1);
    assert.equal(ofMonitor(second.captured, id).length, 0);
  });

  it('opens a draft for an episode an edit started', async () => {
    const id = await monitor(a);
    await setMonitorCheckState(a.orgId, id, {
      consecutiveFailures: 2,
      failureEpisode: 0,
    });
    const { seen } = await capturingTypes(
      app,
      ['monitor/state_changed', 'monitor/threshold_breached'],
      async () => {
        await updateMonitor(app, a.cookie, id, { failureThreshold: 2 });
        await app.eventBus.drain();
      },
    );
    assert.ok(seen.includes('monitor/state_changed'));
    assert.ok(!seen.includes('monitor/threshold_breached'));
    assert.equal((await counters(a, id)).failure_episode, 1);
    await pass([a.orgId]);
    const rows = await incidentsOf(a, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin_failure_episode, 1);
  });

  /** A lost-event draft, dismissed. Returns the monitor and its episode. */
  async function dismissed() {
    const id = await monitor(a);
    await atThreshold(a, id, 1);
    await pass([a.orgId]);
    const [draft] = await incidentsOf(a, id);
    await transitionIncident(app, a.cookie, draft.id, 'resolved');
    return id;
  }

  it('does not reopen a dismissed draft, and failures still count', async () => {
    const id = await dismissed();
    for (let i = 0; i < 3; i++) await pass([a.orgId]);
    assert.equal((await incidentsOf(a, id)).length, 1);
    const before = (await counters(a, id)).consecutive_failures;
    await recordCheckOutcome(app, a.orgId, id, failureOutcome());
    assert.equal((await counters(a, id)).consecutive_failures, before + 1);
    await pass([a.orgId]);
    assert.equal((await incidentsOf(a, id)).length, 1);
  });

  it('does not reopen a confirmed then resolved incident', async () => {
    const id = await monitor(a);
    await atThreshold(a, id, 1);
    await pass([a.orgId]);
    const [draft] = await incidentsOf(a, id);
    await transitionIncident(app, a.cookie, draft.id, 'investigating');
    await pass([a.orgId]);
    await transitionIncident(app, a.cookie, draft.id, 'resolved');
    await pass([a.orgId]);
    await pass([a.orgId]);
    assert.equal((await incidentsOf(a, id)).length, 1);
  });

  it('opens nothing for ineligible monitors', async () => {
    const below = await monitor(a);
    await atThreshold(a, below, 1, 2);
    const disabled = await monitor(a, { enabled: false });
    await atThreshold(a, disabled);
    const service = await createService(app, a.cookie);
    const onArchived = await createMonitor(app, a.cookie, service, {
      failureThreshold: 3,
    });
    await atThreshold(a, onArchived);
    await archiveService(app, a.cookie, service);
    await pass([a.orgId]);
    for (const id of [below, disabled, onArchived]) {
      assert.equal((await incidentsOf(a, id)).length, 0);
    }
  });

  it('opens a draft for the next episode', async () => {
    const id = await dismissed();
    await setMonitorCheckState(a.orgId, id, { consecutiveFailures: 0 });
    await atThreshold(a, id, 2);
    await pass([a.orgId]);
    const rows = await incidentsOf(a, id);
    assert.deepEqual(
      rows.map((r) => r.origin_failure_episode),
      [1, 2],
    );
  });

  it('keeps going when one organization fails', async () => {
    const ida = await monitor(a);
    const idb = await monitor(b);
    await atThreshold(a, ida);
    await atThreshold(b, idb);
    const { logged, log } = logger();
    const seen: { type: string; orgId: unknown }[] = [];
    await runWorkerPass(
      stubApp({ query: (org) => org === a.orgId, seen }),
      log,
      { orgIds: [a.orgId, b.orgId] },
    );
    await app.eventBus.drain();
    const failure = logged.find(
      (l) => l.msg === 'draft reconciliation failed for organization',
    );
    assert.equal(failure?.level, 'error');
    assert.equal(failure?.obj.orgId, a.orgId);
    assert.equal((await incidentsOf(a, ida)).length, 0);
    assert.equal((await incidentsOf(b, idb)).length, 1);
    assert.ok(
      seen.some(
        (c) =>
          c.type === refreshUptimeRollupsCommand.type && c.orgId === a.orgId,
      ),
      'rollup refresh still ran for the failed organization',
    );
  });

  it('opens drafts even when status reconciliation fails', async () => {
    const id = await monitor(a);
    await atThreshold(a, id);
    const { logged, log } = logger();
    await assert.rejects(
      runWorkerPass(stubApp({ reconcile: (org) => org === a.orgId }), log, {
        orgIds: [a.orgId],
      }),
      { message: 'every organization failed (1)' },
    );
    await app.eventBus.drain();
    assert.equal((await incidentsOf(a, id)).length, 1);
    const errors = logged.filter(
      (l) => l.msg === 'worker pass failed for organization',
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].obj.orgId, a.orgId);
  });

  it('skips status reconciliation when the transition fails, and still runs the later steps', async () => {
    const id = await monitor(a);
    await atThreshold(a, id);
    const { logged, log } = logger();
    const seen: { type: string; orgId: unknown }[] = [];
    await assert.rejects(
      runWorkerPass(
        stubApp({ transition: (org) => org === a.orgId, seen }),
        log,
        { orgIds: [a.orgId] },
      ),
      { message: 'every organization failed (1)' },
    );
    await app.eventBus.drain();
    const types = seen.filter((s) => s.orgId === a.orgId).map((s) => s.type);
    // The transition and the reconciliation share one step.
    assert.ok(types.includes('maintenance/transition_due'));
    assert.ok(!types.includes('service/status.reconcile'));
    // The later steps still run.
    assert.ok(types.includes(CREATE_DRAFT));
    assert.ok(types.includes('monitor/refresh_uptime_rollups'));
    assert.equal((await incidentsOf(a, id)).length, 1);
    const errors = logged.filter(
      (l) => l.msg === 'worker pass failed for organization',
    );
    assert.equal(errors.length, 1);
  });

  it('keeps going when one monitor fails', async () => {
    const svc = await createService(app, a.cookie);
    const m1 = await createMonitor(app, a.cookie, svc, { failureThreshold: 3 });
    const m2 = await createMonitor(app, a.cookie, svc, { failureThreshold: 3 });
    await atThreshold(a, m1);
    await atThreshold(a, m2);
    const [first] = [m1, m2].sort();
    const second = first === m1 ? m2 : m1;
    const { logged, log } = logger();
    // The only organization visited is marked failed, so the pass rejects.
    await assert.rejects(
      runWorkerPass(stubApp({ command: (id) => id === first }), log, {
        orgIds: [a.orgId],
      }),
      { message: 'every organization failed (1)' },
    );
    await app.eventBus.drain();
    const errors = logged.filter(
      (l) => l.msg === 'reconciling a monitor draft failed',
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].obj.monitorId, first);
    assert.equal((await incidentsOf(a, first)).length, 0);
    assert.equal((await incidentsOf(a, second)).length, 1);
  });
});
