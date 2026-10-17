import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  type CreateDraftFromMonitorCommandResult,
  createDraftFromMonitorCommand,
} from '@/modules/incident/commands/create-draft-from-monitor/create-draft-from-monitor.handler';
import { timelineMessageFor } from '@/modules/incident/domain/incident-timeline';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as incidentEvents from '@/shared/events/incident.events';
import * as monitorEvents from '@/shared/events/monitor.events';
import { monitorThresholdBreachedEvent } from '@/shared/events/monitor.events';
import { ArgumentInvalidException } from '@/shared/exceptions';
import {
  createCheckResultPartitions,
  createMonitor,
  createService,
  failureOutcome,
  recordCheckOutcome,
  successOutcome,
  transitionIncident,
} from '@/shared/testing/fixtures';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 5.15: open a draft when a monitor breaches its threshold.
 * Runs no worker pass and never orders rows by time (AGENTS.md clock skew).
 */

const tag = `mdr-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';

type Emitted = { type: string; payload: Record<string, unknown> };
const emitted: Emitted[] = [];

type IncidentRow = {
  id: string;
  status: string;
  source: string;
  impact: string;
  title: string;
  created_by_user_id: string | null;
  origin_monitor_id: string | null;
  origin_failure_episode: number | null;
  updated_at: Date;
};

async function monitorName(monitorId: string) {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ name: string }[]>`select name from monitors where id = ${monitorId}`,
  );
  return rows[0].name;
}

async function breach(monitorId: string, failureEpisode: number) {
  app.eventBus.emit(
    monitorThresholdBreachedEvent({
      orgId,
      monitorId,
      serviceId,
      monitorName: await monitorName(monitorId),
      failureEpisode,
    }),
  );
}

function runCommand(monitorId: string, failureEpisode: number) {
  return monitorName(monitorId).then((name) =>
    app.commandBus.execute<CreateDraftFromMonitorCommandResult>(
      createDraftFromMonitorCommand({
        orgId,
        monitorId,
        serviceId,
        monitorName: name,
        failureEpisode,
      }),
    ),
  );
}

async function incidentsOf(monitorId: string) {
  await app.eventBus.drain();
  return withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<IncidentRow[]>`
        select * from incidents where origin_monitor_id = ${monitorId}
        order by origin_failure_episode, id
      `,
  );
}

async function episodeOf(monitorId: string) {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ failure_episode: number; consecutive_failures: number }[]>`
        select failure_episode, consecutive_failures from monitors
        where id = ${monitorId}
      `,
  );
  return rows[0];
}

async function serviceStatus(id = serviceId) {
  await app.eventBus.drain();
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ last_known_status: string }[]>`
        select last_known_status from services where id = ${id}
      `,
  );
  return rows[0].last_known_status;
}

async function eventsFor(
  ids: { monitorId?: string; incidentIds?: string[] },
  type?: string,
) {
  await app.eventBus.drain();
  return emitted.filter(
    (e) =>
      (!type || e.type === type) &&
      ((ids.monitorId !== undefined && e.payload.monitorId === ids.monitorId) ||
        (ids.monitorId !== undefined &&
          e.payload.originMonitorId === ids.monitorId) ||
        (ids.incidentIds?.includes(e.payload.id as string) ?? false)),
  );
}

const newMonitor = (failureThreshold = 2, overrides: object = {}) =>
  createMonitor(app, cookie, serviceId, { failureThreshold, ...overrides });

async function failTimes(monitorId: string, times: number) {
  for (let i = 0; i < times; i++) {
    await recordCheckOutcome(app, orgId, monitorId, failureOutcome());
  }
}

async function patchMonitor(monitorId: string, payload: object) {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/v1/monitors/${monitorId}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
}

describe('Story 5.15: open a draft on a threshold breach', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    serviceId = await createService(app, cookie);
    await createCheckResultPartitions();
    for (const creator of [
      ...Object.values(incidentEvents),
      ...Object.values(monitorEvents),
    ]) {
      if (typeof creator === 'function' && 'type' in creator) {
        app.eventBus.on(creator.type as string, (e: Emitted) =>
          emitted.push({ type: e.type, payload: e.payload }),
        );
      }
    }
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('opens one draft on the first breach', async () => {
    const monitorId = await newMonitor();
    await breach(monitorId, 1);
    const rows = await incidentsOf(monitorId);
    assert.equal(rows.length, 1);
    const [draft] = rows;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.source, 'monitoring');
    assert.equal(draft.impact, 'critical');
    assert.equal(draft.origin_monitor_id, monitorId);
    assert.equal(draft.origin_failure_episode, 1);
    assert.equal(draft.created_by_user_id, null);
    assert.equal(
      draft.title,
      `Monitor failure: ${await monitorName(monitorId)}`,
    );

    const impacts = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ service_id: string; impact: string }[]>`
          select service_id, impact from incident_service_impacts
          where incident_id = ${draft.id}
        `,
    );
    assert.deepEqual(
      impacts.map((i) => [i.service_id, i.impact]),
      [[serviceId, 'critical']],
    );

    const timeline = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<
          {
            status: string;
            message: string;
            created_by_user_id: string | null;
          }[]
        >`select status, message, created_by_user_id from incident_updates
          where incident_id = ${draft.id} order by sequence`,
    );
    assert.deepEqual(
      [...timeline],
      [
        {
          status: 'draft',
          message: timelineMessageFor(null, 'draft'),
          created_by_user_id: null,
        },
      ],
    );

    const ids = { incidentIds: [draft.id] };
    assert.equal((await eventsFor(ids, 'incident/draft_created')).length, 1);
    assert.equal((await eventsFor(ids, 'incident/created')).length, 0);
    assert.equal((await eventsFor(ids, 'incident/update_posted')).length, 0);
    const created = (await eventsFor(ids, 'incident/draft_created'))[0];
    assert.equal(created.payload.originMonitorId, monitorId);
    assert.equal(created.payload.originFailureEpisode, 1);
  });

  it('ignores a repeat and concurrent breaches of one episode', async () => {
    const monitorId = await newMonitor();
    await breach(monitorId, 1);
    await app.eventBus.drain();
    await breach(monitorId, 1);
    assert.equal((await incidentsOf(monitorId)).length, 1);
    assert.equal(
      (await eventsFor({ monitorId }, 'incident/draft_created')).length,
      1,
    );
    assert.equal(await runCommand(monitorId, 1), null);

    const other = await newMonitor();
    await Promise.all([breach(other, 1), breach(other, 1)]);
    const rows = await incidentsOf(other);
    assert.equal(rows.length, 1);
    assert.equal(
      (await eventsFor({ monitorId: other }, 'incident/draft_created')).length,
      1,
    );
  });

  it('opens no second draft for the next episode while one is open', async () => {
    const monitorId = await newMonitor();
    await breach(monitorId, 1);
    await app.eventBus.drain();
    await breach(monitorId, 2);
    assert.equal((await incidentsOf(monitorId)).length, 1);
    assert.equal(await runCommand(monitorId, 2), null);
    assert.equal((await incidentsOf(monitorId)).length, 1);
  });

  it('opens none while a confirmed incident is unresolved, then again after', async () => {
    const monitorId = await newMonitor();
    await breach(monitorId, 1);
    const [draft] = await incidentsOf(monitorId);
    await transitionIncident(app, cookie, draft.id, 'investigating');
    await breach(monitorId, 2);
    assert.equal((await incidentsOf(monitorId)).length, 1);
    let episode = 10;
    for (const status of [
      'investigating',
      'identified',
      'monitoring',
    ] as const) {
      if (status !== 'investigating') {
        await transitionIncident(app, cookie, draft.id, status);
      }
      assert.equal(await runCommand(monitorId, episode++), null, status);
      assert.equal((await incidentsOf(monitorId)).length, 1, status);
    }

    await transitionIncident(app, cookie, draft.id, 'resolved');
    await breach(monitorId, 3);
    const rows = await incidentsOf(monitorId);
    assert.deepEqual(
      rows.map((r) => [r.origin_failure_episode, r.status]),
      [
        [1, 'resolved'],
        [3, 'draft'],
      ],
    );
  });

  it('keeps a dismissed draft dismissed and the service status as it was', async () => {
    const own = await createService(app, cookie);
    const monitorId = await createMonitor(app, cookie, own, {
      failureThreshold: 2,
    });
    await failTimes(monitorId, 2);
    const [draft] = await incidentsOf(monitorId);
    assert.equal(draft.status, 'draft');
    const episode = (await episodeOf(monitorId)).failure_episode;
    assert.equal(draft.origin_failure_episode, episode);

    const before = await serviceStatus(own);
    assert.notEqual(before, 'operational');
    await transitionIncident(app, cookie, draft.id, 'resolved');
    await breach(monitorId, episode);
    assert.equal((await incidentsOf(monitorId)).length, 1);
    assert.equal(await runCommand(monitorId, episode), null);

    const failures = (await episodeOf(monitorId)).consecutive_failures;
    await failTimes(monitorId, 2);
    assert.equal(
      (await episodeOf(monitorId)).consecutive_failures,
      failures + 2,
    );
    assert.equal((await incidentsOf(monitorId)).length, 1);
    assert.equal(await serviceStatus(own), before);
  });

  it('drafts again with the next episode after a recovery', async () => {
    const monitorId = await newMonitor(2);
    await failTimes(monitorId, 2);
    await recordCheckOutcome(app, orgId, monitorId, successOutcome());
    await failTimes(monitorId, 2);
    const rows = await incidentsOf(monitorId);
    assert.equal(rows.length, 1, 'the first draft is still open');

    const [first] = rows;
    await transitionIncident(app, cookie, first.id, 'resolved');
    await recordCheckOutcome(app, orgId, monitorId, successOutcome());
    await failTimes(monitorId, 2);
    const after = await incidentsOf(monitorId);
    assert.equal(after.length, 2);
    assert.equal(
      after[1].origin_failure_episode,
      (await episodeOf(monitorId)).failure_episode,
    );
    assert.ok(
      (after[1].origin_failure_episode as number) >
        (after[0].origin_failure_episode as number),
    );
  });

  it('is neither public nor a status input while open', async () => {
    const own = await createService(app, cookie);
    const monitorId = await createMonitor(app, cookie, own, {
      failureThreshold: 1,
    });
    await recordCheckOutcome(app, orgId, monitorId, failureOutcome());
    const [draft] = await incidentsOf(monitorId);
    assert.equal(draft.status, 'draft');
    const statusOf = async () =>
      (
        await withTenantTransaction(
          orgId,
          ({ sql: tx }) =>
            tx<{ last_known_status: string }[]>`
              select last_known_status from services where id = ${own}
            `,
        )
      )[0].last_known_status;
    await app.eventBus.drain();
    assert.notEqual(await statusOf(), 'operational');

    await patchMonitor(monitorId, { enabled: false });
    await app.eventBus.drain();

    const page = await app.inject({ method: 'GET', url: `/status/${tag}` });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(
      JSON.parse(page.body).activeIncidents.some(
        (i: { id: string }) => i.id === draft.id,
      ),
      false,
    );
    const rows = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ last_known_status: string }[]>`
          select last_known_status from services where id = ${own}
        `,
    );
    assert.equal(rows[0].last_known_status, 'operational');
  });

  it('opens exactly one draft for a threshold of 3 and a 4th failure (FR13)', async () => {
    const monitorId = await newMonitor(3);
    await failTimes(monitorId, 3);
    await failTimes(monitorId, 1);
    const rows = await incidentsOf(monitorId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft');
    assert.equal(
      rows[0].origin_failure_episode,
      (await episodeOf(monitorId)).failure_episode,
    );
    const ids = { incidentIds: [rows[0].id], monitorId };
    assert.equal((await eventsFor(ids, 'incident/draft_created')).length, 1);
    for (const type of [
      'incident/confirmed',
      'incident/dismissed',
      'incident/state_changed',
    ]) {
      assert.equal((await eventsFor(ids, type)).length, 0, type);
    }
  });

  it('opens no draft for an SSL expiry warning', async () => {
    const monitorId = await createMonitor(app, cookie, serviceId, {
      type: 'ssl_expiry',
      target: '203.0.113.10',
      config: { warnDays: 14 },
    });
    const outcome = successOutcome({
      certificateFingerprint: `AA:${tag}`,
      certificateExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      daysRemaining: 7,
    });
    await recordCheckOutcome(app, orgId, monitorId, outcome);
    assert.equal(
      (await eventsFor({ monitorId }, 'monitor/ssl_expiry_warning')).length,
      1,
    );
    assert.equal((await incidentsOf(monitorId)).length, 0);
  });

  it('leaves a draft untouched when the monitor recovers', async () => {
    const monitorId = await newMonitor(2);
    await failTimes(monitorId, 2);
    const [draft] = await incidentsOf(monitorId);
    await recordCheckOutcome(app, orgId, monitorId, successOutcome());
    const [after] = await incidentsOf(monitorId);
    assert.deepEqual({ ...after }, { ...draft });
    assert.equal(
      (await eventsFor({ monitorId }, 'monitor/recovered')).length,
      1,
    );
    const ids = { incidentIds: [draft.id] };
    const incidentEventsSeen = (await eventsFor(ids)).filter((e) =>
      e.type.startsWith('incident/'),
    );
    assert.deepEqual(
      incidentEventsSeen.map((e) => e.type),
      ['incident/draft_created'],
    );
  });

  it('lets a human confirm or dismiss a monitor-born draft', async () => {
    const confirmMonitor = await newMonitor();
    const dismissMonitor = await newMonitor();
    await breach(confirmMonitor, 1);
    await breach(dismissMonitor, 1);
    const [toConfirm] = await incidentsOf(confirmMonitor);
    const [toDismiss] = await incidentsOf(dismissMonitor);

    await transitionIncident(app, cookie, toConfirm.id, 'investigating');
    await transitionIncident(app, cookie, toDismiss.id, 'resolved');

    const typesOf = async (id: string) =>
      (await eventsFor({ incidentIds: [id] })).map((e) => e.type);
    const confirmed = await typesOf(toConfirm.id);
    assert.ok(confirmed.includes('incident/confirmed'));
    assert.ok(!confirmed.includes('incident/resolved'));
    assert.ok(!confirmed.includes('incident/dismissed'));
    const dismissed = await typesOf(toDismiss.id);
    assert.ok(dismissed.includes('incident/dismissed'));
    assert.ok(!dismissed.includes('incident/resolved'));
    assert.ok(!dismissed.includes('incident/confirmed'));
  });

  it('refuses invalid input and writes no row', async () => {
    const monitorId = await newMonitor();
    const run = (over: object) =>
      app.commandBus.execute(
        createDraftFromMonitorCommand({
          orgId,
          monitorId,
          serviceId,
          monitorName: 'x',
          failureEpisode: 1,
          ...over,
        }),
      );
    for (const over of [
      { failureEpisode: 0 },
      { failureEpisode: 1.5 },
      { monitorId: 'not-a-uuid' },
      { serviceId: 'not-a-uuid' },
      { monitorName: '' },
    ]) {
      await assert.rejects(run(over), ArgumentInvalidException);
    }
    assert.equal((await incidentsOf(monitorId)).length, 0);
  });

  it('waits for a confirm in flight, then opens no draft', async () => {
    const monitorId = await newMonitor();
    await breach(monitorId, 1);
    const [draft] = await incidentsOf(monitorId);

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const inFlight = withTenantTransaction(orgId, async ({ sql: tx }) => {
      await tx`select id from incidents where id = ${draft.id} for no key update`;
      await tx`update incidents set status = 'investigating' where id = ${draft.id}`;
      signalLocked();
      await released;
    });
    await locked;

    let settled = false;
    const running = runCommand(monitorId, 2).then((result) => {
      settled = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        settled,
        false,
        'the command waits for the confirm to commit',
      );
      // The null result and the single investigating row below prove the lock.
    } finally {
      release();
      await inFlight;
    }
    assert.equal(await running, null);
    const rows = await incidentsOf(monitorId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'investigating');
  });

  it('declares the foreign key and both indexes', async () => {
    const fk = await sql<{ def: string; confdeltype: string }[]>`
      select pg_get_constraintdef(oid) as def, confdeltype
      from pg_constraint where conname = 'incidents_origin_monitor_fkey'
    `;
    assert.equal(fk.length, 1);
    assert.equal(fk[0].confdeltype, 'n');
    assert.match(fk[0].def, /FOREIGN KEY \(origin_monitor_id, org_id\)/);
    assert.match(fk[0].def, /REFERENCES monitors\(id, org_id\)/);
    assert.match(fk[0].def, /ON DELETE SET NULL \(origin_monitor_id\)/);

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where tablename = 'incidents'
        and indexname in ('incidents_monitor_episode_uk', 'incidents_monitor_draft_uk')
    `;
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
    assert.ok(byName.has('incidents_monitor_draft_uk'));
    const episode = byName.get('incidents_monitor_episode_uk') ?? '';
    assert.match(episode, /UNIQUE/);
    assert.match(
      episode,
      /\(org_id, origin_monitor_id, origin_failure_episode\)/,
    );
    assert.match(episode, /WHERE \(origin_failure_episode IS NOT NULL\)/);
  });
});
