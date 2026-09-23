import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { transitionDueMaintenanceCommand } from '@/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler';
import { updateMaintenanceCommand } from '@/modules/maintenance/commands/update-maintenance/update-maintenance.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { listOrganizationIds } from '@/shared/db/tenants';
import {
  maintenanceCompletedEvent,
  maintenanceStartedEvent,
} from '@/shared/events/maintenance.events';
import { runWorkerPass } from '@/worker';

/** Story 2.15 — transition due maintenance automatically. */

const tag = `due-${randomBytes(4).toString('hex')}`;
const hour = 60 * 60 * 1000;
const silent = pino({ level: 'silent' });

let app: FastifyInstance;
let orgAId = '';
let orgBId = '';

async function createOrg(slug: string) {
  const id = randomBytes(16).toString('hex');
  await sql`
    insert into "organization" ("id", "name", "slug", "createdAt")
    values (${id}, ${slug}, ${slug}, now())
  `;
  return id;
}

async function window(
  orgId: string,
  title: string,
  status: string,
  startOffsetMs: number,
  endOffsetMs: number,
) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ id: string }[]>`
      insert into maintenance (
        org_id, title, status, scheduled_start_at, scheduled_end_at, started_at
      ) values (
        ${orgId}, ${title}, ${status},
        ${new Date(Date.now() + startOffsetMs)},
        ${new Date(Date.now() + endOffsetMs)},
        ${status === 'in_progress' ? new Date(Date.now() + startOffsetMs) : null}
      )
      returning id
    `;
    return rows[0].id;
  });
}

/**
 * A service and a window's cover over it, written directly: this suite has no
 * operator session, and the `service` module may not be imported from here.
 */
async function service(orgId: string, slug: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ id: string }[]>`
      insert into services (org_id, name, slug)
      values (${orgId}, ${slug}, ${slug})
      returning id
    `;
    return rows[0].id;
  });
}

async function cover(orgId: string, maintenanceId: string, serviceId: string) {
  await withTenantTransaction(orgId, async ({ sql: tx }) => {
    await tx`
      insert into maintenance_services (org_id, maintenance_id, service_id)
      values (${orgId}, ${maintenanceId}, ${serviceId})
    `;
  });
}

function statusOf(orgId: string, serviceId: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ last_known_status: string }[]>`
      select last_known_status from services where id = ${serviceId}
    `;
    return rows[0].last_known_status;
  });
}

function stateOf(orgId: string, id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<
      { status: string; started_at: Date | null; completed_at: Date | null }[]
    >`select status, started_at, completed_at from maintenance where id = ${id}`;
    return rows[0];
  });
}

async function capturing<T>(types: string[], run: () => Promise<T>) {
  const seen: string[] = [];
  for (const type of types) app.eventBus.on(type, () => seen.push(type));
  await run();
  return seen;
}

// Scoped to this file's organizations. A pass now reconciles the status of
// every service it visits, and the suites run against one database at once.
const runPass = () => runWorkerPass(app, silent, { orgIds: [orgAId, orgBId] });

describe('Story 2.15: transition due maintenance automatically', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    orgAId = await createOrg(`${tag}-a`);
    orgBId = await createOrg(`${tag}-b`);
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('enumerates tenants from a table outside RLS', async () => {
    // The worker has no request and therefore no app.current_org_id. It can
    // still learn which organizations exist because Better Auth's table sits
    // outside WatchDog's tenant RLS. See ARCHITECTURE.md 6.0.
    const ids = await listOrganizationIds();

    assert.ok(ids.includes(orgAId));
    assert.ok(ids.includes(orgBId));
  });

  it('starts a due window, and follows an edit to what it covers', async () => {
    // The chain through the product's own paths: the worker's transition, the
    // maintenance.started it emits, the recomputation that follows, then an
    // edit and the recomputation after that. Every other in-progress fixture
    // is an insert with the event emitted by hand, which is what Epic 2's
    // VG-2 was left open for, and the Epic 3 retrospective carried as item 19.
    const covered = await service(orgAId, `${tag}-covered`);
    const moved = await service(orgAId, `${tag}-moved`);
    const windowId = await window(
      orgAId,
      'Due cover',
      'scheduled',
      -hour,
      hour,
    );
    await cover(orgAId, windowId, covered);

    const moves = await app.commandBus.execute<
      Promise<{ started: number; completed: number }>
    >(transitionDueMaintenanceCommand({ orgId: orgAId }));
    assert.equal(moves.started, 1, 'the worker started the window');
    await app.eventBus.drain();

    assert.equal(await statusOf(orgAId, covered), 'maintenance');
    assert.equal(await statusOf(orgAId, moved), 'operational');

    await app.commandBus.execute(
      updateMaintenanceCommand({
        orgId: orgAId,
        id: windowId,
        affectedServiceIds: [moved],
      }),
    );
    await app.eventBus.drain();

    assert.equal(await statusOf(orgAId, covered), 'operational');
    assert.equal(await statusOf(orgAId, moved), 'maintenance');
  });

  it('starts a window whose start time has passed', async () => {
    const id = await window(
      orgAId,
      `${tag}-starting`,
      'scheduled',
      -hour,
      hour,
    );

    const seen = await capturing([maintenanceStartedEvent.type], runPass);

    assert.ok(seen.includes(maintenanceStartedEvent.type));
    const state = await stateOf(orgAId, id);
    assert.equal(state.status, 'in_progress');
    assert.ok(state.started_at instanceof Date);
  });

  it('completes a window whose end time has passed', async () => {
    const id = await window(
      orgAId,
      `${tag}-ending`,
      'in_progress',
      -2 * hour,
      -hour,
    );

    const seen = await capturing([maintenanceCompletedEvent.type], runPass);

    assert.ok(seen.includes(maintenanceCompletedEvent.type));
    assert.equal((await stateOf(orgAId, id)).status, 'completed');
  });

  it('sends a wholly elapsed window straight to completed', async () => {
    const id = await window(
      orgAId,
      `${tag}-elapsed`,
      'scheduled',
      -3 * hour,
      -2 * hour,
    );

    const seen = await capturing(
      [maintenanceStartedEvent.type, maintenanceCompletedEvent.type],
      runPass,
    );

    // DOMAIN lists scheduled to completed as a legal worker transition for
    // exactly this case. Passing through in_progress would announce a start
    // that never happened.
    assert.ok(!seen.includes(maintenanceStartedEvent.type));
    assert.ok(seen.includes(maintenanceCompletedEvent.type));

    // The stored row must not claim a start either. completeDue used to stamp
    // started_at on a window that never ran, so the record disagreed with the
    // events and with the manual path. Epic 2 retrospective, R-8.
    const state = await stateOf(orgAId, id);
    assert.equal(state.status, 'completed');
    assert.equal(state.started_at, null, 'it never started');
    assert.ok(state.completed_at instanceof Date);
  });

  it('moves nothing and announces nothing on a second pass', async () => {
    await window(orgAId, `${tag}-settled`, 'scheduled', -hour, hour);
    await runPass();

    const seen = await capturing(
      [maintenanceStartedEvent.type, maintenanceCompletedEvent.type],
      runPass,
    );

    assert.deepEqual(seen, [], 'a repeated pass is a no-op');
  });

  it('leaves a window that is not yet due alone', async () => {
    const id = await window(
      orgAId,
      `${tag}-future`,
      'scheduled',
      hour,
      2 * hour,
    );

    await runPass();

    assert.equal((await stateOf(orgAId, id)).status, 'scheduled');
  });

  it('transitions each organization under its own tenant context', async () => {
    const a = await window(orgAId, `${tag}-multi-a`, 'scheduled', -hour, hour);
    const b = await window(orgBId, `${tag}-multi-b`, 'scheduled', -hour, hour);

    await runPass();

    assert.equal((await stateOf(orgAId, a)).status, 'in_progress');
    assert.equal((await stateOf(orgBId, b)).status, 'in_progress');

    // Neither organization's pass saw the other's row.
    const crossed = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) => tx`select 1 from maintenance where id = ${b}`,
    );
    assert.equal(crossed.length, 0);
  });

  it('reconciles service status that drifted, as part of the pass', async () => {
    // Nothing affects this service, so its stored major_outage can only be a
    // recomputation that was lost. The pass is what notices.
    const serviceId = await withTenantTransaction(
      orgAId,
      async ({ sql: tx }) => {
        const [row] = await tx<{ id: string }[]>`
        insert into services (org_id, name, slug, last_known_status)
        values (${orgAId}, ${`${tag}-drift`}, ${`${tag}-drift`}, 'major_outage')
        returning id
      `;
        return row.id;
      },
    );

    await runPass();

    const [{ last_known_status: status }] = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) =>
        tx<{ last_known_status: string }[]>`
        select last_known_status from services where id = ${serviceId}
      `,
    );
    assert.equal(status, 'operational');
  });

  it('continues past an organization whose pass fails', async () => {
    const healthy = await window(
      orgAId,
      `${tag}-healthy`,
      'scheduled',
      -hour,
      hour,
    );

    // An id no organization has. The command opens a tenant transaction for it
    // and finds nothing; the point is that the loop keeps going.
    await assert.doesNotReject(
      app.commandBus.execute(
        transitionDueMaintenanceCommand({ orgId: 'nonexistent-org-id' }),
      ),
    );

    await runPass();
    assert.equal((await stateOf(orgAId, healthy)).status, 'in_progress');
  });
});
