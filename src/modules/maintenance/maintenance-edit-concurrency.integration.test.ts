import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { completeMaintenanceCommand } from '@/modules/maintenance/commands/complete-maintenance/complete-maintenance.handler';
import { deleteMaintenanceCommand } from '@/modules/maintenance/commands/delete-maintenance/delete-maintenance.handler';
import { updateMaintenanceCommand } from '@/modules/maintenance/commands/update-maintenance/update-maintenance.handler';
import {
  CompletedMaintenanceImmutableError,
  MaintenanceNotDeletableError,
  RunningMaintenanceFieldsError,
} from '@/modules/maintenance/domain/maintenance.errors';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceUpdatedEvent } from '@/shared/events/maintenance.events';
import { NotFoundException } from '@/shared/exceptions';
import { capturing } from '@/shared/testing/events';
import { createService, scheduleMaintenance } from '@/shared/testing/fixtures';
import { holdTransaction, waitUntilBlockedBy } from '@/shared/testing/locks';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * GH #148: maintenance edits, deletes and completions read the window under
 * its row lock. A worker transition is simulated by the raw statement
 * `startDue` or `completeDue` would run, inside the held transaction; no
 * worker pass runs here.
 *
 * Each test holds a writer open, starts the command, proves with
 * `pg_blocking_pids` that the command waits on it, then commits.
 */

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];

async function newOrg() {
  const label = `mnt-edit-${randomBytes(4).toString('hex')}`;
  const org = await signUpWithOrg(app, label);
  created.push({ orgId: org.orgId, userId: org.userId });
  return org;
}

type Settled = { value: unknown } | { error: unknown };

const shown = (settled: Settled) =>
  String('error' in settled ? settled.error : settled.value);

/** Runs `start` while `work` holds a transaction, and returns the settled command. */
async function against(
  orgId: string,
  work: (tx: typeof sql) => Promise<unknown>,
  start: () => Promise<unknown>,
): Promise<Settled> {
  const holder = await holdTransaction(orgId, work);
  const pending: Promise<Settled> = start().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await waitUntilBlockedBy(holder.pid, 'the command');
    await holder.commit();
    const settled = await pending;
    await app.eventBus.drain();
    return settled;
  } finally {
    await holder.commit().catch(() => {});
    await pending;
  }
}

const serviceIds = (orgId: string, id: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) =>
    (
      await tx<{ service_id: string }[]>`
        select service_id from maintenance_services
        where maintenance_id = ${id} order by service_id
      `
    ).map((row) => row.service_id),
  );

const titleOf = (orgId: string, id: string) =>
  withTenantTransaction(
    orgId,
    async ({ sql: tx }) =>
      (
        await tx<{ title: string }[]>`
          select title from maintenance where id = ${id}
        `
      )[0]?.title,
  );

const countFor = (captured: unknown[], id: string) =>
  (captured as { payload: { id: string } }[]).filter(
    (event) => event.payload.id === id,
  ).length;

describe('GH #148: maintenance edits under the row lock', () => {
  before(async () => {
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    for (const { orgId, userId } of created) {
      await sql`delete from "organization" where "id" = ${orgId}`;
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('(a) two service replacements do not merge', async () => {
    const { orgId, cookie } = await newOrg();
    const x = await createService(app, cookie);
    const a = await createService(app, cookie);
    const b = await createService(app, cookie);
    const id = await scheduleMaintenance(app, cookie, {
      affectedServiceIds: [x],
    });
    await app.eventBus.drain();
    const settled = await against(
      orgId,
      async (tx) => {
        await tx`select id from maintenance where id = ${id} for no key update`;
        await tx`delete from maintenance_services where maintenance_id = ${id}`;
        await tx`
          insert into maintenance_services (org_id, maintenance_id, service_id)
          values (${orgId}, ${id}, ${b})
        `;
      },
      () =>
        app.commandBus.execute(
          updateMaintenanceCommand({ orgId, id, affectedServiceIds: [a] }),
        ),
    );
    assert.ok(!('error' in settled), shown(settled));
    assert.deepEqual(await serviceIds(orgId, id), [a]);
  });

  it('(c) A, B, A announces the last edit', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await scheduleMaintenance(app, cookie, { title: 'A' });
    await app.eventBus.drain();
    const { captured, result } = await capturing(
      app,
      maintenanceUpdatedEvent.type,
      () =>
        against(
          orgId,
          async (tx) => {
            await tx`update maintenance set title = 'B' where id = ${id}`;
          },
          () =>
            app.commandBus.execute(
              updateMaintenanceCommand({ orgId, id, title: 'A' }),
            ),
        ),
    );
    assert.ok(!('error' in result), shown(result));
    assert.equal(await titleOf(orgId, id), 'A');
    assert.equal(countFor(captured, id), 1);
  });

  it('(b) a window that started refuses a restricted edit', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await scheduleMaintenance(app, cookie, { title: 'Old' });
    await app.eventBus.drain();
    const { captured, result } = await capturing(
      app,
      maintenanceUpdatedEvent.type,
      () =>
        against(
          orgId,
          async (tx) => {
            await tx`
              update maintenance
            set status = 'in_progress', started_at = now(), updated_at = now()
              where id = ${id}
            `;
          },
          () =>
            app.commandBus.execute(
              updateMaintenanceCommand({ orgId, id, title: 'New' }),
            ),
        ),
    );
    assert.ok('error' in result, `expected a refusal, got ${shown(result)}`);
    assert.ok(
      result.error instanceof RunningMaintenanceFieldsError,
      String(result.error),
    );
    assert.equal(await titleOf(orgId, id), 'Old');
    assert.equal(countFor(captured, id), 0);
  });

  it('(b) a completed window refuses a service change', async () => {
    const { orgId, cookie } = await newOrg();
    const x = await createService(app, cookie);
    const a = await createService(app, cookie);
    const id = await scheduleMaintenance(app, cookie, {
      affectedServiceIds: [x],
    });
    await app.eventBus.drain();
    const settled = await against(
      orgId,
      async (tx) => {
        await tx`
          update maintenance
            set status = 'completed', completed_at = now(), updated_at = now()
          where id = ${id}
        `;
      },
      () =>
        app.commandBus.execute(
          updateMaintenanceCommand({ orgId, id, affectedServiceIds: [a] }),
        ),
    );
    assert.ok('error' in settled, `expected a refusal, got ${shown(settled)}`);
    assert.ok(
      settled.error instanceof CompletedMaintenanceImmutableError,
      String(settled.error),
    );
    assert.deepEqual(await serviceIds(orgId, id), [x]);
  });

  it('a delete during a start answers not deletable, not not found', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await scheduleMaintenance(app, cookie);
    await app.eventBus.drain();
    const settled = await against(
      orgId,
      async (tx) => {
        await tx`
          update maintenance
            set status = 'in_progress', started_at = now(), updated_at = now()
          where id = ${id}
        `;
      },
      () => app.commandBus.execute(deleteMaintenanceCommand({ orgId, id })),
    );
    assert.ok('error' in settled, `expected a refusal, got ${shown(settled)}`);
    assert.ok(
      settled.error instanceof MaintenanceNotDeletableError,
      String(settled.error),
    );
  });

  it('a complete during a delete answers not found', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await scheduleMaintenance(app, cookie);
    await app.eventBus.drain();
    const settled = await against(
      orgId,
      async (tx) => {
        await tx`delete from maintenance where id = ${id}`;
      },
      () => app.commandBus.execute(completeMaintenanceCommand({ orgId, id })),
    );
    assert.ok('error' in settled, `expected a refusal, got ${shown(settled)}`);
    assert.ok(
      settled.error instanceof NotFoundException,
      String(settled.error),
    );
  });

  it('a no-op edit announces nothing', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await scheduleMaintenance(app, cookie, { title: 'Same' });
    await app.eventBus.drain();
    const { captured } = await capturing(
      app,
      maintenanceUpdatedEvent.type,
      async () => {
        await app.commandBus.execute(
          updateMaintenanceCommand({ orgId, id, title: 'Same' }),
        );
        await app.eventBus.drain();
      },
    );
    assert.equal(countFor(captured, id), 0);
  });
});
