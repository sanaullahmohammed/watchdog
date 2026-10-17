import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import makeRecomputeServiceStatus, {
  type RecomputeServiceStatusCommandResult,
  recomputeServiceStatusCommand,
} from '@/modules/service/commands/recompute-service-status/recompute-service-status.event-handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentConfirmedEvent } from '@/shared/events/incident.events';
import { maintenanceStartedEvent } from '@/shared/events/maintenance.events';
import {
  monitorCheckFailedEvent,
  monitorCheckSucceededEvent,
  monitorStateChangedEvent,
} from '@/shared/events/monitor.events';
import { serviceStatusChangedEvent } from '@/shared/events/service.events';
import {
  archiveService,
  createMonitor,
  createService,
  declareIncident,
  restoreService,
  setMonitorCheckState,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';

/** Story 2.17 — recompute and announce service status. */

const ORIGIN = 'http://localhost:3000';
const tag = `rsc-${randomBytes(4).toString('hex')}`;
const day = 24 * 60 * 60 * 1000;

type Recomputer = ReturnType<typeof makeRecomputeServiceStatus>;
type Change = {
  id: string;
  orgId: string;
  slug: string;
  from: string;
  to: string;
};

let app: FastifyInstance;
let recomputer: Recomputer;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
const announced: Change[] = [];
const confirmed: string[] = [];

function api(
  cookie: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

/** An incident written straight to the table, so no event announces it. */
async function silentIncident(
  orgId: string,
  serviceId: string,
  impact: string,
  status: string,
) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [{ id }] = await tx<{ id: string }[]>`
      insert into incidents (org_id, title, status, impact, source)
      values (
        ${orgId}, 'Silent', ${status}, ${impact},
        ${status === 'draft' ? 'monitoring' : 'manual'}
      )
      returning id
    `;
    await tx`
      insert into incident_service_impacts (org_id, incident_id, service_id, impact)
      values (${orgId}, ${id}, ${serviceId}, ${impact})
    `;
    return id;
  });
}

/**
 * An in-progress window ending far in the future, so no other file's worker
 * pass can complete it underneath this one.
 */
async function inProgressWindow(orgId: string, serviceId: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [{ id }] = await tx<{ id: string }[]>`
      insert into maintenance (
        org_id, title, status, scheduled_start_at, scheduled_end_at, started_at
      ) values (
        ${orgId}, 'Window', 'in_progress', ${new Date(Date.now() - day)},
        ${new Date(Date.now() + day)}, ${new Date(Date.now() - day)}
      )
      returning id
    `;
    await tx`
      insert into maintenance_services (org_id, maintenance_id, service_id)
      values (${orgId}, ${id}, ${serviceId})
    `;
    return id;
  });
}

async function stored(orgId: string, id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<{ last_known_status: string; xmin: string }[]>`
      select last_known_status, xmin::text from services where id = ${id}
    `;
    return { status: row.last_known_status, xmin: row.xmin };
  });
}

const statusOf = async (orgId: string, id: string) =>
  (await stored(orgId, id)).status;

const announcedFor = (id: string) => announced.filter((c) => c.id === id);

/** Waits for every recomputation the events so far have started. */
const settle = () => app.eventBus.drain();

describe('Story 2.17: recompute and announce service status', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    recomputer = app.diContainer.resolve(
      'recomputeServiceStatusEventHandler' as never,
    ) as Recomputer;
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, `${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(app, `${tag}-b`));

    app.eventBus.on(serviceStatusChangedEvent.type, (event) =>
      announced.push(event.payload as Change),
    );
    app.eventBus.on(incidentConfirmedEvent.type, (event) =>
      confirmed.push((event.payload as { id: string }).id),
    );
  });

  after(async () => {
    await settle();
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('writes the new status and announces it when an incident names a service', async () => {
    const slug = `${tag}-api`;
    const id = await createService(app, cookieA, { name: slug, slug });

    await declareIncident(app, cookieA, {
      title: 'critical trouble',
      impact: 'critical',
      affectedServices: [{ serviceId: id, impact: 'critical' }],
    });
    await settle();

    assert.equal(await statusOf(orgAId, id), 'major_outage');
    assert.deepEqual(announcedFor(id), [
      { id, orgId: orgAId, slug, from: 'operational', to: 'major_outage' },
    ]);
  });

  it('writes nothing and announces nothing when the answer has not moved', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-steady`,
      slug: `${tag}-steady`,
    });
    await declareIncident(app, cookieA, {
      title: 'minor trouble',
      impact: 'minor',
      affectedServices: [{ serviceId: id, impact: 'minor' }],
    });
    await settle();
    const settled = await stored(orgAId, id);
    assert.equal(settled.status, 'degraded');

    for (let run = 0; run < 3; run++) {
      assert.deepEqual(await recomputer.recompute(orgAId), []);
    }

    // xmin moves on any UPDATE, even one writing the same value back. A row
    // lock does not touch it.
    assert.equal((await stored(orgAId, id)).xmin, settled.xmin);
    assert.equal(announcedFor(id).length, 1);
  });

  it('returns the service to operational, once, when the incident resolves', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-resolves`,
      slug: `${tag}-resolves`,
    });
    const incidentId = await declareIncident(app, cookieA, {
      title: 'major trouble',
      impact: 'major',
      affectedServices: [{ serviceId: id, impact: 'major' }],
    });
    await settle();
    assert.equal(await statusOf(orgAId, id), 'partial_outage');

    const response = await api(
      cookieA,
      'POST',
      `/incidents/${incidentId}/transition`,
      { status: 'resolved' },
    );
    assert.equal(response.statusCode, 200, response.body);
    await settle();

    // Resolving emits state_changed and resolved; only one of the two
    // recomputations finds a difference.
    assert.equal(await statusOf(orgAId, id), 'operational');
    assert.deepEqual(
      announcedFor(id).map((c) => c.to),
      ['partial_outage', 'operational'],
    );
  });

  it('ignores a draft until it is confirmed', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-draft`,
      slug: `${tag}-draft`,
    });
    const incidentId = await silentIncident(orgAId, id, 'critical', 'draft');

    assert.deepEqual(
      await recomputer.recompute(orgAId),
      [],
      'a draft was never shown to customers',
    );

    const response = await api(
      cookieA,
      'POST',
      `/incidents/${incidentId}/transition`,
      { status: 'investigating' },
    );
    assert.equal(response.statusCode, 200, response.body);
    await settle();

    assert.ok(confirmed.includes(incidentId));
    assert.equal(await statusOf(orgAId, id), 'major_outage');
  });

  it('counts an incident in monitoring, the status the page also lists', async () => {
    // Which statuses are active is one shared subset now, so this and the
    // public page cannot disagree about what "active" means (AV-3). No fixture
    // anywhere reached `monitoring` before (VG-F).
    const id = await createService(app, cookieA, {
      name: `${tag}-watching`,
      slug: `${tag}-watching`,
    });
    await silentIncident(orgAId, id, 'major', 'monitoring');

    assert.deepEqual(
      (await recomputer.recompute(orgAId)).map((change) => [
        change.slug,
        change.to,
      ]),
      [[`${tag}-watching`, 'partial_outage']],
      'a mitigation being watched is still an outage to a customer',
    );
    assert.equal(await statusOf(orgAId, id), 'partial_outage');
  });

  it('follows an edit that drops the service from an active incident', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-dropped`,
      slug: `${tag}-dropped`,
    });
    const incidentId = await declareIncident(app, cookieA, {
      title: 'critical trouble',
      impact: 'critical',
      affectedServices: [{ serviceId: id, impact: 'critical' }],
    });
    await settle();
    assert.equal(await statusOf(orgAId, id), 'major_outage');

    const response = await api(cookieA, 'PATCH', `/incidents/${incidentId}`, {
      affectedServices: [],
    });
    assert.equal(response.statusCode, 200, response.body);
    await settle();

    assert.equal(await statusOf(orgAId, id), 'operational');
  });

  it('follows a window into maintenance, and back out when it completes', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-window`,
      slug: `${tag}-window`,
    });
    const windowId = await inProgressWindow(orgAId, id);

    app.eventBus.emit(maintenanceStartedEvent({ id: windowId, orgId: orgAId }));
    await settle();
    assert.equal(await statusOf(orgAId, id), 'maintenance');

    // Completing is the way out for work that happened; deleting a running
    // window is refused (retrospective R-8). This is also the path no test
    // covered before: maintenance.completed driving a recomputation (VG-1).
    const response = await api(
      cookieA,
      'POST',
      `/maintenance/${windowId}/complete`,
    );
    assert.ok(response.statusCode < 300, response.body);
    await settle();

    assert.equal(await statusOf(orgAId, id), 'operational');
  });

  it('follows an edit that swaps the services a running window covers', async () => {
    // The trigger story 2.17 added maintenance.updated for, which no test
    // exercised through a running window (VG-2).
    const before = await createService(app, cookieA, {
      name: `${tag}-covered-before`,
      slug: `${tag}-covered-before`,
    });
    const after = await createService(app, cookieA, {
      name: `${tag}-covered-after`,
      slug: `${tag}-covered-after`,
    });
    const windowId = await inProgressWindow(orgAId, before);

    app.eventBus.emit(maintenanceStartedEvent({ id: windowId, orgId: orgAId }));
    await settle();
    assert.equal(await statusOf(orgAId, before), 'maintenance');

    const response = await api(cookieA, 'PATCH', `/maintenance/${windowId}`, {
      affectedServiceIds: [after],
    });
    assert.equal(response.statusCode, 200, response.body);
    await settle();

    assert.equal(await statusOf(orgAId, before), 'operational');
    assert.equal(await statusOf(orgAId, after), 'maintenance');
  });

  it('lets an override win, and falls back to computed status when cleared', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-override`,
      slug: `${tag}-override`,
    });
    await declareIncident(app, cookieA, {
      title: 'critical trouble',
      impact: 'critical',
      affectedServices: [{ serviceId: id, impact: 'critical' }],
    });
    await settle();

    await api(cookieA, 'PUT', `/services/${id}/status-override`, {
      status: 'operational',
    });
    await settle();
    assert.equal(await statusOf(orgAId, id), 'operational');

    await api(cookieA, 'DELETE', `/services/${id}/status-override`);
    await settle();
    assert.equal(await statusOf(orgAId, id), 'major_outage');
  });

  it('skips an archived service, and recomputes it when restored', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-archived`,
      slug: `${tag}-archived`,
    });
    const archive = await api(cookieA, 'POST', `/services/${id}/archive`);
    assert.equal(archive.statusCode, 200, archive.body);
    await silentIncident(orgAId, id, 'critical', 'investigating');

    const changes = await recomputer.recompute(orgAId);

    assert.ok(!changes.some((c) => c.id === id));
    assert.equal(await statusOf(orgAId, id), 'operational');

    const restore = await api(cookieA, 'POST', `/services/${id}/restore`);
    assert.equal(restore.statusCode, 200, restore.body);
    await settle();

    assert.equal(await statusOf(orgAId, id), 'major_outage');
  });

  it('recomputes each organization under its own tenant context', async () => {
    const serviceA = await createService(app, cookieA, {
      name: `${tag}-tenant-a`,
      slug: `${tag}-tenant-a`,
    });
    const serviceB = await createService(app, cookieB, {
      name: `${tag}-tenant-b`,
      slug: `${tag}-tenant-b`,
    });
    const windowA = await inProgressWindow(orgAId, serviceA);
    const windowB = await inProgressWindow(orgBId, serviceB);

    // Both have drifted; recomputing A must not reach B.
    await recomputer.recompute(orgAId);
    assert.equal(await statusOf(orgAId, serviceA), 'maintenance');
    assert.equal(await statusOf(orgBId, serviceB), 'operational');

    // What one worker pass across both organizations emits.
    app.eventBus.emit(maintenanceStartedEvent({ id: windowA, orgId: orgAId }));
    app.eventBus.emit(maintenanceStartedEvent({ id: windowB, orgId: orgBId }));
    await settle();

    assert.equal(await statusOf(orgBId, serviceB), 'maintenance');
    assert.deepEqual(
      announcedFor(serviceB).map((c) => c.orgId),
      [orgBId],
    );
    assert.deepEqual(
      announcedFor(serviceA).map((c) => c.orgId),
      [orgAId],
    );
  });

  it('announces a change exactly once when recomputations race', async () => {
    const id = await createService(app, cookieA, {
      name: `${tag}-race`,
      slug: `${tag}-race`,
    });
    await silentIncident(orgAId, id, 'minor', 'investigating');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => recomputer.recompute(orgAId)),
    );

    assert.equal(results.flat().filter((c) => c.id === id).length, 1);
    assert.equal(announcedFor(id).length, 1);
    assert.equal(await statusOf(orgAId, id), 'degraded');
  });

  it('reconciles a status that drifted, through the command the worker runs', async () => {
    const slug = `${tag}-drifted`;
    const id = await createService(app, cookieA, { name: slug, slug });
    await declareIncident(app, cookieA, {
      title: 'critical trouble',
      impact: 'critical',
      affectedServices: [{ serviceId: id, impact: 'critical' }],
    });
    await settle();
    assert.equal(await statusOf(orgAId, id), 'major_outage');

    // Stand in for a recomputation that failed: the incident is still active,
    // the stored value says otherwise, and no event will fire again.
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        update services set last_known_status = 'operational' where id = ${id}
      `;
    });

    const corrected =
      await app.commandBus.execute<RecomputeServiceStatusCommandResult>(
        recomputeServiceStatusCommand({ orgId: orgAId }),
      );

    assert.deepEqual(
      corrected
        .filter((change) => change.id === id)
        .map((change) => [change.from, change.to]),
      [['operational', 'major_outage']],
    );
    assert.equal(await statusOf(orgAId, id), 'major_outage');

    // Idempotent: a healthy organization writes nothing and announces nothing,
    // which is what makes running this every pass cheap.
    const second =
      await app.commandBus.execute<RecomputeServiceStatusCommandResult>(
        recomputeServiceStatusCommand({ orgId: orgAId }),
      );
    assert.deepEqual(second, []);
  });

  it('contains a failed recomputation instead of taking the process down', async () => {
    recomputer.handler({ type: 'incident.created', payload: { orgId: '' } });

    await assert.doesNotReject(settle());
  });

  describe('Story 5.10: monitor state moves service status', () => {
    const fresh = async (label: string) => {
      const slug = `${tag}-${label}`;
      return createService(app, cookieA, { name: slug, slug });
    };

    const monitorFor = async (
      serviceId: string,
      failures: number,
      overrides: object = {},
      state: { lastCheckedAt?: Date | null } = {},
    ) => {
      const monitorId = await createMonitor(app, cookieA, serviceId, {
        failureThreshold: 3,
        ...overrides,
      });
      await setMonitorCheckState(orgAId, monitorId, {
        consecutiveFailures: failures,
        ...state,
      });
      return monitorId;
    };

    const base = (monitorId: string, serviceId: string) => ({
      orgId: orgAId,
      monitorId,
      serviceId,
      monitorName: 'mon',
    });

    const emitStateChanged = async (monitorId: string, serviceId: string) => {
      app.eventBus.emit(
        monitorStateChangedEvent({
          ...base(monitorId, serviceId),
          from: 'healthy',
          to: 'failing',
          failureEpisode: 1,
        }),
      );
      await settle();
    };

    it('moves the service on monitor.state_changed, announcing once', async () => {
      const id = await fresh('m-trigger');
      const monitorId = await monitorFor(id, 3);
      await emitStateChanged(monitorId, id);

      assert.equal(await statusOf(orgAId, id), 'major_outage');
      assert.deepEqual(announcedFor(id), [
        {
          id,
          orgId: orgAId,
          slug: `${tag}-m-trigger`,
          from: 'operational',
          to: 'major_outage',
        },
      ]);
    });

    it('is not moved by check events', async () => {
      const id = await fresh('m-checks');
      const monitorId = await monitorFor(id, 3);
      const checkedAt = new Date().toISOString();
      app.eventBus.emit(
        monitorCheckFailedEvent({
          ...base(monitorId, id),
          checkedAt,
          errorCode: 'timeout',
        }),
      );
      app.eventBus.emit(
        monitorCheckSucceededEvent({ ...base(monitorId, id), checkedAt }),
      );
      await settle();

      assert.equal(await statusOf(orgAId, id), 'operational');
      assert.deepEqual(announcedFor(id), []);
    });

    it("takes the worst of a service's monitors", async () => {
      const id = await fresh('m-worst');
      await monitorFor(id, 0);
      const failing = await monitorFor(id, 3);
      await emitStateChanged(failing, id);
      assert.equal(await statusOf(orgAId, id), 'major_outage');
    });

    it('ignores a disabled monitor', async () => {
      const id = await fresh('m-disabled');
      const monitorId = await monitorFor(id, 3, { enabled: false });
      await emitStateChanged(monitorId, id);
      assert.equal(await statusOf(orgAId, id), 'operational');
    });

    it('ignores a monitor that has never been checked', async () => {
      const id = await fresh('m-unchecked');
      const monitorId = await monitorFor(id, 3, {}, { lastCheckedAt: null });
      await emitStateChanged(monitorId, id);
      assert.equal(await statusOf(orgAId, id), 'operational');
    });

    it('lets a manual override beat a failing monitor', async () => {
      const id = await fresh('m-override');
      const monitorId = await monitorFor(id, 3);
      const put = await api(cookieA, 'PUT', `/services/${id}/status-override`, {
        status: 'degraded',
      });
      assert.equal(put.statusCode, 200, put.body);
      await emitStateChanged(monitorId, id);
      assert.equal(await statusOf(orgAId, id), 'degraded');
    });

    it('resolves the worst of a monitor and an incident', async () => {
      const failingId = await fresh('m-fail-inc');
      const failing = await monitorFor(failingId, 3);
      await silentIncident(orgAId, failingId, 'minor', 'investigating');
      await emitStateChanged(failing, failingId);
      assert.equal(await statusOf(orgAId, failingId), 'major_outage');

      const healthyId = await fresh('m-ok-inc');
      const healthy = await monitorFor(healthyId, 0);
      await silentIncident(orgAId, healthyId, 'minor', 'investigating');
      await emitStateChanged(healthy, healthyId);
      assert.equal(await statusOf(orgAId, healthyId), 'degraded');
    });

    it('returns to operational when the monitor is disabled', async () => {
      const id = await fresh('m-disable');
      const monitorId = await monitorFor(id, 3);
      await emitStateChanged(monitorId, id);
      assert.equal(await statusOf(orgAId, id), 'major_outage');

      const patched = await api(cookieA, 'PATCH', `/monitors/${monitorId}`, {
        enabled: false,
      });
      assert.equal(patched.statusCode, 200, patched.body);
      await settle();
      assert.equal(await statusOf(orgAId, id), 'operational');
      assert.deepEqual(
        announcedFor(id).map((c) => [c.from, c.to]),
        [
          ['operational', 'major_outage'],
          ['major_outage', 'operational'],
        ],
      );
    });

    it('eases to degraded when the threshold is raised above the failures', async () => {
      const id = await fresh('m-threshold');
      const monitorId = await monitorFor(id, 3);
      await emitStateChanged(monitorId, id);
      assert.equal(await statusOf(orgAId, id), 'major_outage');

      const patched = await api(cookieA, 'PATCH', `/monitors/${monitorId}`, {
        failureThreshold: 5,
      });
      assert.equal(patched.statusCode, 200, patched.body);
      await settle();
      assert.equal(await statusOf(orgAId, id), 'degraded');
    });

    it('corrects a lost event on the next reconciliation', async () => {
      const id = await fresh('m-lost');
      await monitorFor(id, 3);
      assert.equal(await statusOf(orgAId, id), 'operational');

      const corrected =
        await app.commandBus.execute<RecomputeServiceStatusCommandResult>(
          recomputeServiceStatusCommand({ orgId: orgAId }),
        );
      assert.deepEqual(
        corrected
          .filter((change) => change.id === id)
          .map((change) => [change.from, change.to]),
        [['operational', 'major_outage']],
      );
      assert.equal(await statusOf(orgAId, id), 'major_outage');
    });

    it('skips an archived service, and a restore brings the status back', async () => {
      const id = await fresh('m-archived');
      await monitorFor(id, 3);
      await archiveService(app, cookieA, id);
      await settle();

      const changes = await recomputer.recompute(orgAId);
      assert.deepEqual(
        changes.filter((change) => change.id === id),
        [],
      );
      assert.equal(await statusOf(orgAId, id), 'operational');

      await restoreService(app, cookieA, id);
      await settle();
      assert.equal(await statusOf(orgAId, id), 'major_outage');
      assert.deepEqual(
        announcedFor(id).map((c) => [c.from, c.to]),
        [['operational', 'major_outage']],
      );
    });

    it("does not read another organization's monitors", async () => {
      const idA = await fresh('m-scope-a');
      const slugB = `${tag}-m-scope-b`;
      const idB = await createService(app, cookieB, {
        name: slugB,
        slug: slugB,
      });
      const monitorB = await createMonitor(app, cookieB, idB, {
        failureThreshold: 3,
      });
      await setMonitorCheckState(orgBId, monitorB, { consecutiveFailures: 3 });
      const before = announced.length;

      const changes = await recomputer.recompute(orgAId);

      assert.equal(await statusOf(orgAId, idA), 'operational');
      assert.equal(await statusOf(orgBId, idB), 'operational');
      assert.deepEqual(
        changes.filter((change) => change.orgId !== orgAId),
        [],
      );
      assert.deepEqual(
        announced.slice(before).filter((change) => change.orgId !== orgAId),
        [],
      );
    });
  });
});
