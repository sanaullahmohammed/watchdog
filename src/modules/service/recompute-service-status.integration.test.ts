import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type makeRecomputeServiceStatus from '@/modules/service/commands/recompute-service-status/recompute-service-status.event-handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentConfirmedEvent } from '@/shared/events/incident.events';
import { maintenanceStartedEvent } from '@/shared/events/maintenance.events';
import { serviceStatusChangedEvent } from '@/shared/events/service.events';

/** Story 2.17 — recompute and announce service status. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
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
const settle = () => recomputer.drain();

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
    } = await signUpWithOrg(`${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(`${tag}-b`));

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
    const id = await createService(cookieA, slug);

    await declare(cookieA, id, 'critical');
    await settle();

    assert.equal(await statusOf(orgAId, id), 'major_outage');
    assert.deepEqual(announcedFor(id), [
      { id, orgId: orgAId, slug, from: 'operational', to: 'major_outage' },
    ]);
  });

  it('writes nothing and announces nothing when the answer has not moved', async () => {
    const id = await createService(cookieA, `${tag}-steady`);
    await declare(cookieA, id, 'minor');
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
    const id = await createService(cookieA, `${tag}-resolves`);
    const incidentId = await declare(cookieA, id, 'major');
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
    const id = await createService(cookieA, `${tag}-draft`);
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

  it('follows an edit that drops the service from an active incident', async () => {
    const id = await createService(cookieA, `${tag}-dropped`);
    const incidentId = await declare(cookieA, id, 'critical');
    await settle();
    assert.equal(await statusOf(orgAId, id), 'major_outage');

    const response = await api(cookieA, 'PATCH', `/incidents/${incidentId}`, {
      affectedServices: [],
    });
    assert.equal(response.statusCode, 200, response.body);
    await settle();

    assert.equal(await statusOf(orgAId, id), 'operational');
  });

  it('follows a window into maintenance, and back out when it is deleted', async () => {
    const id = await createService(cookieA, `${tag}-window`);
    const windowId = await inProgressWindow(orgAId, id);

    app.eventBus.emit(maintenanceStartedEvent({ id: windowId, orgId: orgAId }));
    await settle();
    assert.equal(await statusOf(orgAId, id), 'maintenance');

    const response = await api(cookieA, 'DELETE', `/maintenance/${windowId}`);
    assert.ok(response.statusCode < 300, response.body);
    await settle();

    // The window's links cascaded away before the handler ran.
    assert.equal(await statusOf(orgAId, id), 'operational');
  });

  it('lets an override win, and falls back to computed status when cleared', async () => {
    const id = await createService(cookieA, `${tag}-override`);
    await declare(cookieA, id, 'critical');
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
    const id = await createService(cookieA, `${tag}-archived`);
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
    const serviceA = await createService(cookieA, `${tag}-tenant-a`);
    const serviceB = await createService(cookieB, `${tag}-tenant-b`);
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
    const id = await createService(cookieA, `${tag}-race`);
    await silentIncident(orgAId, id, 'minor', 'investigating');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => recomputer.recompute(orgAId)),
    );

    assert.equal(results.flat().filter((c) => c.id === id).length, 1);
    assert.equal(announcedFor(id).length, 1);
    assert.equal(await statusOf(orgAId, id), 'degraded');
  });

  it('contains a failed recomputation instead of taking the process down', async () => {
    recomputer.handler({ type: 'incident.created', payload: { orgId: '' } });

    await assert.doesNotReject(settle());
  });
});
