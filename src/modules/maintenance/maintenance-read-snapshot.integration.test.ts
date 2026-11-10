import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { updateMaintenanceCommand } from '@/modules/maintenance/commands/update-maintenance/update-maintenance.handler';
import type { MaintenanceEntity } from '@/modules/maintenance/domain/maintenance.types';
import { getMaintenanceQuery } from '@/modules/maintenance/queries/get-maintenance/get-maintenance.handler';
import { listMaintenanceQuery } from '@/modules/maintenance/queries/list-maintenance/list-maintenance.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import { createService, scheduleMaintenance } from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * GH #150: a maintenance window and its affected services are read in one
 * snapshot. The repository reads the window rows and then their
 * `maintenance_services` in a second statement; an edit committed between the
 * two must not show as old fields with new services.
 *
 * The edit commits on another connection, through the real
 * `updateMaintenanceCommand`, right after the window statement returns and
 * before the services statement runs. Sabotage: drop
 * `isolation: 'repeatable read'` from `get-maintenance.handler.ts` or
 * `list-maintenance.handler.ts` and that handler's test fails.
 *
 * The gate matches the window read by `/\bfrom maintenance\b/` in a bare
 * awaited template and returns a plain Promise for it, so the test depends on
 * the repository reading the window that way; update it if that changes.
 */

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];

async function newOrg() {
  const label = `mnt-snap-${randomBytes(4).toString('hex')}`;
  const org = await signUpWithOrg(app, label);
  created.push({ orgId: org.orgId, userId: org.userId });
  return org;
}

type Repository = Record<'findById' | 'list', (...args: never[]) => unknown>;

/**
 * Runs `read` with `method` patched so that, after the first statement reading
 * `maintenance`, `commitEdit` runs and commits before the next statement. The
 * returned `fired` says the gate was reached.
 */
async function gated<T>(
  method: 'findById' | 'list',
  commitEdit: () => Promise<unknown>,
  read: () => Promise<T>,
): Promise<{ value: T; fired: boolean }> {
  const repository = app.diContainer.resolve(
    'maintenanceRepository' as never,
  ) as Repository;
  const original = repository[method];
  let fired = false;
  repository[method] = ((...args: unknown[]) => {
    const [tx, , options] = args as [
      TenantTransaction,
      unknown,
      { lock?: string } | undefined,
    ];
    // The edit's own findById goes through this singleton too. `fired` is set
    // before `commitEdit` runs, which is what lets the edit through; the lock
    // check is a second guard.
    if (fired || (method === 'findById' && options?.lock)) {
      return (original as (...a: unknown[]) => unknown).apply(repository, args);
    }
    const proxy = new Proxy(tx.sql, {
      apply(target, thisArg, callArgs) {
        const result = Reflect.apply(target, thisArg, callArgs);
        const strings = callArgs[0] as unknown;
        const text = Array.isArray(strings) ? strings.join(' ') : '';
        if (!fired && /\bfrom maintenance\b/.test(text)) {
          fired = true;
          return (result as Promise<unknown>).then(async (rows) => {
            await commitEdit();
            return rows;
          });
        }
        return result;
      },
    });
    return (original as (...a: unknown[]) => unknown).apply(repository, [
      { ...tx, sql: proxy },
      ...args.slice(1),
    ]);
  }) as Repository[typeof method];
  try {
    const value = await read();
    return { value, fired };
  } finally {
    await app.eventBus.drain().catch(() => {});
    repository[method] = original;
  }
}

const read = (query: Parameters<FastifyInstance['queryBus']['execute']>[0]) =>
  app.queryBus.execute(query) as Promise<MaintenanceEntity>;
const readAll = (
  query: Parameters<FastifyInstance['queryBus']['execute']>[0],
) => app.queryBus.execute(query) as Promise<MaintenanceEntity[]>;

async function seed() {
  const { orgId, cookie } = await newOrg();
  const a = await createService(app, cookie);
  const b = await createService(app, cookie);
  const id = await scheduleMaintenance(app, cookie, {
    title: 'Old',
    affectedServiceIds: [a],
  });
  await app.eventBus.drain();
  const commitEdit = () =>
    app.commandBus.execute(
      updateMaintenanceCommand({
        orgId,
        id,
        title: 'New',
        affectedServiceIds: [b],
      }),
    );
  return { orgId, id, a, b, commitEdit };
}

describe('GH #150: maintenance reads one snapshot', () => {
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

  it('get returns the window and its services as one state', async () => {
    const { orgId, id, a, b, commitEdit } = await seed();
    const { value, fired } = await gated('findById', commitEdit, () =>
      read(getMaintenanceQuery({ orgId, id })),
    );
    assert.ok(fired, 'the edit committed between the two statements');
    assert.equal(value.title, 'Old');
    assert.deepEqual(value.affectedServiceIds, [a]);

    const after = await read(getMaintenanceQuery({ orgId, id }));
    assert.equal(after.title, 'New');
    assert.deepEqual(after.affectedServiceIds, [b]);
  });

  it('list returns the window and its services as one state', async () => {
    const { orgId, id, a, b, commitEdit } = await seed();
    const { value, fired } = await gated('list', commitEdit, () =>
      readAll(listMaintenanceQuery({ orgId })),
    );
    assert.ok(fired, 'the edit committed between the two statements');
    const entry = value.find((window) => window.id === id);
    assert.ok(entry);
    assert.equal(entry.title, 'Old');
    assert.deepEqual(entry.affectedServiceIds, [a]);

    const later = (await readAll(listMaintenanceQuery({ orgId }))).find(
      (window) => window.id === id,
    );
    assert.ok(later);
    assert.equal(later.title, 'New');
    assert.deepEqual(later.affectedServiceIds, [b]);
  });
});
