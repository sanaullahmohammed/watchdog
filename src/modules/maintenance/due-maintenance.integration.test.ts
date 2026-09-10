import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { transitionDueMaintenanceCommand } from '@/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { listOrganizationIds } from '@/shared/db/tenants';
import {
  maintenanceCompletedEvent,
  maintenanceStartedEvent,
} from '@/shared/events/maintenance.events';
import { runMaintenancePass } from '@/worker';

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

const runPass = () => runMaintenancePass(app, silent);

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
    assert.equal((await stateOf(orgAId, id)).status, 'completed');
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
