import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { updateIncidentCommand } from '@/modules/incident/commands/update-incident/update-incident.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentUpdatedEvent } from '@/shared/events/incident.events';
import { capturing } from '@/shared/testing/events';
import { createService, declareIncident } from '@/shared/testing/fixtures';
import { holdTransaction, waitUntilBlockedBy } from '@/shared/testing/locks';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * GH #148: an incident edit reads the row under its row lock, so a concurrent
 * edit is judged against the committed row, never a stale one.
 *
 * Each test holds a writer's transaction open, starts the command, proves with
 * `pg_blocking_pids` that the command is waiting on the writer, then commits.
 * Without the lock the command still blocks later (on its `update incidents`
 * or its `delete from incident_service_impacts`), so the wait succeeds; the
 * final-state and event-count assertions are what catch a missing lock.
 */

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];

async function newOrg() {
  const label = `inc-edit-${randomBytes(4).toString('hex')}`;
  const org = await signUpWithOrg(app, label);
  created.push({ orgId: org.orgId, userId: org.userId });
  return org;
}

const impactServiceIds = (orgId: string, incidentId: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) =>
    (
      await tx<{ service_id: string }[]>`
        select service_id from incident_service_impacts
        where incident_id = ${incidentId} order by service_id
      `
    ).map((row) => row.service_id),
  );

const titleOf = (orgId: string, incidentId: string) =>
  withTenantTransaction(
    orgId,
    async ({ sql: tx }) =>
      (
        await tx<{ title: string }[]>`
          select title from incidents where id = ${incidentId}
        `
      )[0]?.title,
  );

describe('GH #148: incident edits under the row lock', () => {
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
    const id = await declareIncident(app, cookie, {
      affectedServices: [{ serviceId: x, impact: 'minor' }],
    });
    await app.eventBus.drain();

    const holder = await holdTransaction(orgId, async (tx) => {
      await tx`select id from incidents where id = ${id} for no key update`;
      await tx`delete from incident_service_impacts where incident_id = ${id}`;
      await tx`
        insert into incident_service_impacts (org_id, incident_id, service_id, impact)
        values (${orgId}, ${id}, ${b}, 'minor')
      `;
    });
    const pending = app.commandBus
      .execute(
        updateIncidentCommand({
          orgId,
          id,
          affectedServices: [{ serviceId: a, impact: 'minor' }],
        }),
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await waitUntilBlockedBy(holder.pid, 'the incident edit');
      await holder.commit();
      const outcome = await pending;
      assert.ok(
        !('error' in outcome),
        String('error' in outcome && outcome.error),
      );
    } finally {
      await holder.commit().catch(() => {});
    }
    await app.eventBus.drain();
    assert.deepEqual(await impactServiceIds(orgId, id), [a]);
  });

  it('(c) A, B, A announces the last edit', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await declareIncident(app, cookie, { title: 'A' });
    await app.eventBus.drain();

    const { captured } = await capturing(
      app,
      incidentUpdatedEvent.type,
      async () => {
        const holder = await holdTransaction(orgId, async (tx) => {
          await tx`update incidents set title = 'B' where id = ${id}`;
        });
        const pending = app.commandBus
          .execute(updateIncidentCommand({ orgId, id, title: 'A' }))
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        try {
          await waitUntilBlockedBy(holder.pid, 'the incident edit');
          await holder.commit();
          const outcome = await pending;
          assert.ok(
            !('error' in outcome),
            String('error' in outcome ? outcome.error : outcome.value),
          );
        } finally {
          await holder.commit().catch(() => {});
          await pending;
        }
        await app.eventBus.drain();
      },
    );
    assert.equal(await titleOf(orgId, id), 'A');
    const mine = (captured as { payload: { id: string } }[]).filter(
      (event) => event.payload.id === id,
    );
    assert.equal(mine.length, 1);
  });

  it('a no-op edit announces nothing', async () => {
    const { orgId, cookie } = await newOrg();
    const id = await declareIncident(app, cookie, { title: 'Same' });
    await app.eventBus.drain();
    const { captured } = await capturing(
      app,
      incidentUpdatedEvent.type,
      async () => {
        await app.commandBus.execute(
          updateIncidentCommand({ orgId, id, title: 'Same' }),
        );
        await app.eventBus.drain();
      },
    );
    const mine = (captured as { payload: { id: string } }[]).filter(
      (event) => event.payload.id === id,
    );
    assert.equal(mine.length, 0);
  });
});
