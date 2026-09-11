import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type makeRecomputeServiceStatus from '@/modules/service/commands/recompute-service-status/recompute-service-status.event-handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceStartedEvent } from '@/shared/events/maintenance.events';

/** Story 2.18 — serve resolved status through the service queries. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `srv-${randomBytes(4).toString('hex')}`;
const day = 24 * 60 * 60 * 1000;

/** Every field of the SDL `Service` type, so a GraphQL read can be compared whole. */
const SERVICE_FIELDS =
  'id serviceGroupId name slug description manualStatusOverride isPublic displayOrder archivedAt lastKnownStatus';

type Recomputer = ReturnType<typeof makeRecomputeServiceStatus>;
type ServiceBody = { slug: string; lastKnownStatus: string } & Record<
  string,
  unknown
>;
type GraphQLBody<T> = {
  data: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
};

let app: FastifyInstance;
let recomputer: Recomputer;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';

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

function api(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
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

async function gql<T>(
  cookie: string | undefined,
  query: string,
  variables?: object,
): Promise<GraphQLBody<T>> {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: cookie ? { cookie } : {},
    payload: { query, variables },
  });
  return JSON.parse(response.body);
}

async function createService(cookie: string, slug: string) {
  const response = await api(cookie, 'POST', '/services', { name: slug, slug });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

async function declare(cookie: string, serviceId: string, impact: string) {
  const response = await api(cookie, 'POST', '/incidents', {
    title: `${impact} trouble`,
    impact,
    affectedServices: [{ serviceId, impact }],
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

/**
 * Starts a window the way the worker does: the row moves to in_progress, then
 * maintenance.started is emitted. Written directly rather than through a
 * worker pass, which would act on every other test file's organizations too.
 */
async function openWindow(orgId: string, serviceId: string) {
  const id = await withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<{ id: string }[]>`
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
      values (${orgId}, ${row.id}, ${serviceId})
    `;
    return row.id;
  });
  app.eventBus.emit(maintenanceStartedEvent({ id, orgId }));
}

async function restRead(cookie: string, id: string) {
  const response = await api(cookie, 'GET', `/services/${id}`);
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as ServiceBody;
}

async function restList(cookie: string) {
  const response = await api(cookie, 'GET', '/services');
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as ServiceBody[];
}

async function listedStatuses(cookie: string) {
  return new Map(
    (await restList(cookie)).map((s) => [s.slug, s.lastKnownStatus]),
  );
}

/** Waits for every recomputation the events so far have started. */
const settle = () => recomputer.drain();

describe('Story 2.18: serve resolved status through the service queries', () => {
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
    } = await signUpWithOrg(`${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(`${tag}-b`));
  });

  after(async () => {
    await settle();
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('lists each service with the status its precedence condition resolves to', async () => {
    await createService(cookieA, `${tag}-quiet`);
    const incident = await createService(cookieA, `${tag}-incident`);
    const maintained = await createService(cookieA, `${tag}-maintained`);
    const overridden = await createService(cookieA, `${tag}-overridden`);

    await declare(cookieA, incident, 'major');
    await openWindow(orgAId, maintained);
    // The override has to beat a live critical incident, not merely stand in
    // for an absence of inputs.
    await declare(cookieA, overridden, 'critical');
    await api(cookieA, 'PUT', `/services/${overridden}/status-override`, {
      status: 'degraded',
    });
    await settle();

    // Monitor-derived state is the fourth input. Nothing can set it until
    // Epic 5 adds monitors, which carries that case.
    const statuses = await listedStatuses(cookieA);
    assert.equal(statuses.get(`${tag}-quiet`), 'operational');
    assert.equal(statuses.get(`${tag}-incident`), 'partial_outage');
    assert.equal(statuses.get(`${tag}-maintained`), 'maintenance');
    assert.equal(statuses.get(`${tag}-overridden`), 'degraded');
  });

  it('serves the stored status rather than recomputing it per request', async () => {
    const slug = `${tag}-stored`;
    const id = await createService(cookieA, slug);

    // Nothing about this service's inputs says major_outage. Writing it
    // directly makes the stored value and a recomputation disagree, so what
    // the reads return shows which of the two they consulted.
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        update services set last_known_status = 'major_outage' where id = ${id}
      `;
    });

    assert.equal((await restRead(cookieA, id)).lastKnownStatus, 'major_outage');
    assert.equal((await listedStatuses(cookieA)).get(slug), 'major_outage');
    const graph = await gql<{ service: { lastKnownStatus: string } }>(
      cookieA,
      'query ($id: ID!) { service(id: $id) { lastKnownStatus } }',
      { id },
    );
    assert.equal(graph.data?.service.lastKnownStatus, 'major_outage');

    // Only the recomputation handler corrects it.
    await recomputer.recompute(orgAId);
    assert.equal((await restRead(cookieA, id)).lastKnownStatus, 'operational');
  });

  it('reflects an incident opening and resolving on the next read, with nothing to invalidate', async () => {
    const id = await createService(cookieA, `${tag}-lifecycle`);
    assert.equal((await restRead(cookieA, id)).lastKnownStatus, 'operational');

    const incidentId = await declare(cookieA, id, 'critical');
    await settle();
    assert.equal((await restRead(cookieA, id)).lastKnownStatus, 'major_outage');

    const resolved = await api(
      cookieA,
      'POST',
      `/incidents/${incidentId}/transition`,
      { status: 'resolved' },
    );
    assert.equal(resolved.statusCode, 200, resolved.body);
    await settle();
    assert.equal((await restRead(cookieA, id)).lastKnownStatus, 'operational');
  });

  it('returns identical services over REST and GraphQL', async () => {
    const id = await createService(cookieA, `${tag}-parity`);
    await declare(cookieA, id, 'minor');
    await settle();

    const rest = await restRead(cookieA, id);
    assert.equal(rest.lastKnownStatus, 'degraded');
    const one = await gql<{ service: ServiceBody }>(
      cookieA,
      `query ($id: ID!) { service(id: $id) { ${SERVICE_FIELDS} } }`,
      { id },
    );
    assert.deepEqual(one.data?.service, rest);

    const many = await gql<{ services: ServiceBody[] }>(
      cookieA,
      `{ services { ${SERVICE_FIELDS} } }`,
    );
    assert.deepEqual(many.data?.services, await restList(cookieA));
  });

  it('reads one service by id, archived included, and nothing across organizations', async () => {
    const slug = `${tag}-single`;
    const id = await createService(cookieA, slug);
    assert.equal((await restRead(cookieA, id)).slug, slug);

    const archive = await api(cookieA, 'POST', `/services/${id}/archive`);
    assert.equal(archive.statusCode, 200, archive.body);
    assert.notEqual(
      (await restRead(cookieA, id)).archivedAt,
      null,
      'a read by id is how an archived service is found to restore',
    );

    const foreign = await api(cookieB, 'GET', `/services/${id}`);
    assert.equal(foreign.statusCode, 404, foreign.body);
    const missing = await api(cookieA, 'GET', `/services/${randomUUID()}`);
    assert.equal(missing.statusCode, 404, missing.body);

    const foreignGraph = await gql(
      cookieB,
      'query ($id: ID!) { service(id: $id) { id } }',
      { id },
    );
    assert.equal(foreignGraph.data, null);
    assert.ok((foreignGraph.errors ?? []).length > 0);
  });

  it('refuses an unauthenticated read over both surfaces', async () => {
    const id = await createService(cookieA, `${tag}-guarded`);

    const rest = await app.inject({
      method: 'GET',
      url: `/api/v1/services/${id}`,
    });
    assert.equal(rest.statusCode, 401, rest.body);

    const graph = await gql(
      undefined,
      'query ($id: ID!) { service(id: $id) { id } }',
      { id },
    );
    assert.equal(graph.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
  });
});
