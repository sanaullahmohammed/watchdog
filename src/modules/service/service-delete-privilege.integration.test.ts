import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { createService } from '@/shared/testing/fixtures';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/** Story 9.14 - the runtime role cannot hard-delete a service. */

const tag = randomBytes(4).toString('hex');

let app: FastifyInstance;
let main: Awaited<ReturnType<typeof signUpWithOrg>>;
let other: Awaited<ReturnType<typeof signUpWithOrg>>;

const countService = (orgId: string, id: string) =>
  withTenantTransaction(
    orgId,
    async ({ sql: tx }) =>
      (await tx`select 1 from services where id = ${id}`).length,
  );

describe('Story 9.14: no hard delete of a service', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    main = await signUpWithOrg(app, `del-a-${tag}`);
    other = await signUpWithOrg(app, `del-b-${tag}`);
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" in (${main.orgId}, ${other.orgId})`;
    await sql`delete from "user" where "id" in (${main.userId}, ${other.userId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('refuses a raw delete and keeps the row', async () => {
    const id = await createService(app, main.cookie);
    await assert.rejects(
      withTenantTransaction(main.orgId, async ({ sql: tx }) => {
        await tx`delete from services where id = ${id}`;
      }),
      /permission denied for table services/,
    );
    assert.equal(await countService(main.orgId, id), 1);
  });

  it('grants the runtime role exactly insert, select and update', async () => {
    const grants = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'services'
        and grantee = 'watchdog_app'
    `;
    assert.deepEqual(grants.map((g) => g.privilege_type).sort(), [
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  it('still archives and restores a service', async () => {
    const id = await createService(app, main.cookie);
    const archivedAt = async () =>
      withTenantTransaction(
        main.orgId,
        async ({ sql: tx }) =>
          (await tx`select archived_at from services where id = ${id}`)[0]
            .archived_at as Date | null,
      );
    for (const action of ['archive', 'restore']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/services/${id}/${action}`,
        headers: { cookie: main.cookie, origin: TEST_ORIGIN },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), { changed: true });
      if (action === 'archive') assert.notEqual(await archivedAt(), null);
      else assert.equal(await archivedAt(), null);
    }
  });

  it('still removes a service when its organization is deleted', async () => {
    const id = await createService(app, other.cookie);
    assert.equal(await countService(other.orgId, id), 1);
    await sql`delete from "organization" where "id" = ${other.orgId}`;
    assert.equal(await countService(other.orgId, id), 0);
  });
});
