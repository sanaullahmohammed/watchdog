import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { timelineMessageFor } from '@/modules/incident/domain/incident-timeline';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentCreatedEvent } from '@/shared/events/incident.events';

/** Story 2.8 — declare an incident. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `inc-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let serviceAId = '';
let serviceBId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function signUpWithOrg(label: string) {
  const email = `${label}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name: label },
  });
  const cookie = captureCookie(signUp.headers as Record<string, unknown>);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    select "id" from "user" where "email" = ${email}
  `;
  const org = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { cookie, origin: ORIGIN },
    payload: { name: label, slug: label },
  });
  return { cookie, userId, orgId: JSON.parse(org.body).id as string };
}

async function createService(cookie: string, slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: { cookie, origin: ORIGIN },
    payload: { name: slug, slug },
  });
  return JSON.parse(response.body).id as string;
}

function declare(cookie: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

describe('Story 2.8: declare an incident', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(`${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(`${tag}-b`));
    serviceAId = await createService(cookieA, `${tag}-svc-a`);
    serviceBId = await createService(cookieB, `${tag}-svc-b`);
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('starts a declared incident at investigating, never at draft', async () => {
    const { result, captured } = await capturing(
      incidentCreatedEvent.type,
      () =>
        declare(cookieA, {
          title: 'Checkout is failing',
          impact: 'major',
          affectedServices: [{ serviceId: serviceAId, impact: 'major' }],
        }),
    );

    assert.equal(result.statusCode, 201, result.body);
    assert.equal(captured.length, 1);

    const { id } = JSON.parse(result.body);
    const row = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<
        {
          status: string;
          source: string;
          impact: string;
          created_by_user_id: string | null;
        }[]
      >`select status, source, impact, created_by_user_id from incidents where id = ${id}`;
      return rows[0];
    });

    assert.deepEqual(row, {
      status: 'investigating',
      source: 'manual',
      impact: 'major',
      created_by_user_id: userAId,
    });
  });

  it('opens the timeline with the declaration, worded or by default', async () => {
    const idOf = async (payload: Record<string, unknown>) => {
      const response = await declare(cookieA, payload);
      assert.equal(response.statusCode, 201, response.body);
      return JSON.parse(response.body).id as string;
    };
    const worded = await idOf({
      title: 'Worded',
      impact: 'minor',
      message: 'Search is slow for some customers.',
    });
    const unworded = await idOf({ title: 'Unworded', impact: 'minor' });

    const entriesOf = (incidentId: string) =>
      withTenantTransaction(orgAId, async ({ sql: tx }) => [
        ...(await tx<
          {
            status: string;
            message: string;
            created_by_user_id: string | null;
          }[]
        >`
          select status, message, created_by_user_id from incident_updates
          where incident_id = ${incidentId}
        `),
      ]);

    assert.deepEqual(await entriesOf(worded), [
      {
        status: 'investigating',
        message: 'Search is slow for some customers.',
        created_by_user_id: userAId,
      },
    ]);
    assert.deepEqual(await entriesOf(unworded), [
      {
        status: 'investigating',
        message: timelineMessageFor(null, 'investigating'),
        created_by_user_id: userAId,
      },
    ]);
  });

  it('records per-service impact on the join table', async () => {
    const response = await declare(cookieA, {
      title: 'Partial degradation',
      impact: 'minor',
      affectedServices: [{ serviceId: serviceAId, impact: 'minor' }],
    });
    const { id } = JSON.parse(response.body);

    const impacts = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      return tx<{ service_id: string; impact: string; org_id: string }[]>`
        select service_id, impact, org_id from incident_service_impacts
        where incident_id = ${id}
      `;
    });

    assert.equal(impacts.length, 1);
    assert.equal(impacts[0].service_id, serviceAId);
    assert.equal(impacts[0].impact, 'minor');
    // Carries org_id itself rather than reaching it through a join, so RLS
    // applies to this table in its own right.
    assert.equal(impacts[0].org_id, orgAId);
  });

  it('accepts an incident declared before its blast radius is known', async () => {
    const response = await declare(cookieA, {
      title: 'Something is wrong',
      impact: 'none',
    });

    assert.equal(response.statusCode, 201, response.body);
  });

  it('refuses to attach a service from another organization', async () => {
    const response = await declare(cookieA, {
      title: 'Cross-tenant attempt',
      impact: 'critical',
      affectedServices: [{ serviceId: serviceBId, impact: 'critical' }],
    });

    // Refused by the composite key on (service_id, org_id). RLS alone hides
    // the service from reads without preventing this reference.
    assert.equal(response.statusCode, 400, response.body);

    const leaked = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) =>
        tx`select 1 from incident_service_impacts where service_id = ${serviceBId}`,
    );
    assert.equal(leaked.length, 0);
  });

  it('rejects an impact outside the ladder, at the API and at the database', async () => {
    const viaApi = await declare(cookieA, {
      title: 'Bad impact',
      impact: 'apocalyptic',
    });
    assert.equal(viaApi.statusCode, 400, viaApi.body);

    await assert.rejects(
      withTenantTransaction(orgAId, async ({ sql: tx }) => {
        await tx`
          insert into incidents (org_id, title, status, impact)
          values (${orgAId}, 'direct', 'investigating', 'apocalyptic')
        `;
      }),
      /incidents_impact_ck/,
    );
  });

  it('allows only one open draft per monitor', async () => {
    const monitorId = randomBytes(16)
      .toString('hex')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

    // Drafts are monitor-born and arrive in Epic 5; the guard is the partial
    // unique index, which exists now and is what makes duplicates impossible
    // rather than merely unlikely.
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        insert into incidents (org_id, title, status, impact, origin_monitor_id, source)
        values (${orgAId}, 'first draft', 'draft', 'major', ${monitorId}, 'monitoring')
      `;
    });

    await assert.rejects(
      withTenantTransaction(orgAId, async ({ sql: tx }) => {
        await tx`
          insert into incidents (org_id, title, status, impact, origin_monitor_id, source)
          values (${orgAId}, 'second draft', 'draft', 'major', ${monitorId}, 'monitoring')
        `;
      }),
      // Pinned to the index alone. A looser pattern would have let a status
      // CHECK violation pass for this assertion, which is exactly what a typo
      // in this test did before it was tightened.
      /incidents_monitor_draft_uk/,
    );

    // A resolved incident for the same monitor is fine; only drafts collide.
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        insert into incidents (org_id, title, status, impact, origin_monitor_id, source, resolved_at)
        values (${orgAId}, 'old one', 'resolved', 'major', ${monitorId}, 'monitoring', now())
      `;
    });
  });
});
