import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  incidentConfirmedEvent,
  incidentDismissedEvent,
  incidentResolvedEvent,
  incidentStateChangedEvent,
  incidentUpdatedEvent,
} from '@/shared/events/incident.events';

/** Story 2.9 — move an incident through its lifecycle. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `lif-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
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

async function declare(cookie: string, title: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: ORIGIN },
    payload: { title, impact: 'major' },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

function transition(cookie: string, id: string, status: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/incidents/${id}/transition`,
    headers: { cookie, origin: ORIGIN },
    payload: { status },
  });
}

async function capturing<T>(types: string[], run: () => Promise<T>) {
  const seen: string[] = [];
  for (const type of types) {
    app.eventBus.on(type, () => seen.push(type));
  }
  const result = await run();
  return { result, seen };
}

async function statusOf(orgId: string, id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<
      {
        status: string;
        title: string;
        impact: string;
        resolved_at: Date | null;
      }[]
    >`select status, title, impact, resolved_at from incidents where id = ${id}`;
    return rows[0];
  });
}

describe('Story 2.9: move an incident through its lifecycle', () => {
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
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('advances along a legal transition and announces the move', async () => {
    const id = await declare(cookieA, 'Advancing');

    const { result, seen } = await capturing(
      [incidentStateChangedEvent.type],
      () => transition(cookieA, id, 'identified'),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(seen, [incidentStateChangedEvent.type]);
    assert.equal((await statusOf(orgAId, id)).status, 'identified');
  });

  it('rejects an illegal transition and writes nothing', async () => {
    const id = await declare(cookieA, 'Illegal move');

    // investigating -> draft is not in DOMAIN's table.
    const response = await transition(cookieA, id, 'draft');

    assert.equal(response.statusCode, 400, response.body);
    assert.equal((await statusOf(orgAId, id)).status, 'investigating');
  });

  it('sets resolved_at and announces incident.resolved for a public lifecycle', async () => {
    const id = await declare(cookieA, 'Will resolve');

    const { seen } = await capturing(
      [
        incidentStateChangedEvent.type,
        incidentResolvedEvent.type,
        incidentDismissedEvent.type,
      ],
      () => transition(cookieA, id, 'resolved'),
    );

    assert.deepEqual(seen, [
      incidentStateChangedEvent.type,
      incidentResolvedEvent.type,
    ]);
    assert.ok(!seen.includes(incidentDismissedEvent.type));

    const row = await statusOf(orgAId, id);
    assert.equal(row.status, 'resolved');
    assert.ok(row.resolved_at instanceof Date);
  });

  it('announces a dismissed draft as dismissed, never as resolved', async () => {
    const [{ id }] = await withTenantTransaction(
      orgAId,
      async ({ sql: tx }) => {
        return tx<{ id: string }[]>`
        insert into incidents (org_id, title, status, impact, source)
        values (${orgAId}, 'Monitor noise', 'draft', 'major', 'monitoring')
        returning id
      `;
      },
    );

    const { seen } = await capturing(
      [
        incidentStateChangedEvent.type,
        incidentResolvedEvent.type,
        incidentDismissedEvent.type,
      ],
      () => transition(cookieA, id, 'resolved'),
    );

    // Both land on `resolved`. Only one of them was ever shown to customers,
    // and ARCHITECTURE 5.4 reserves incident.resolved for that one.
    assert.ok(seen.includes(incidentDismissedEvent.type));
    assert.ok(
      !seen.includes(incidentResolvedEvent.type),
      'a dismissed draft must never announce itself as resolved',
    );
    assert.equal((await statusOf(orgAId, id)).status, 'resolved');
  });

  it('announces a confirmed draft as incident.confirmed, and only that move', async () => {
    const [{ id }] = await withTenantTransaction(
      orgAId,
      async ({ sql: tx }) => {
        return tx<{ id: string }[]>`
        insert into incidents (org_id, title, status, impact, source)
        values (${orgAId}, 'Monitor alarm', 'draft', 'major', 'monitoring')
        returning id
      `;
      },
    );

    const confirming = await capturing(
      [incidentStateChangedEvent.type, incidentConfirmedEvent.type],
      () => transition(cookieA, id, 'investigating'),
    );
    assert.equal(confirming.result.statusCode, 200, confirming.result.body);
    assert.deepEqual(confirming.seen, [
      incidentStateChangedEvent.type,
      incidentConfirmedEvent.type,
    ]);

    const advancing = await capturing([incidentConfirmedEvent.type], () =>
      transition(cookieA, id, 'identified'),
    );
    assert.deepEqual(
      advancing.seen,
      [],
      'only leaving draft confirms an incident',
    );
  });

  it('treats an edit as incident.updated, distinct from a state change', async () => {
    const id = await declare(cookieA, 'Original title');

    const { result, seen } = await capturing(
      [incidentUpdatedEvent.type, incidentStateChangedEvent.type],
      () =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/incidents/${id}`,
          headers: { cookie: cookieA, origin: ORIGIN },
          payload: { title: 'Clearer title', impact: 'minor' },
        }),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(
      seen,
      [incidentUpdatedEvent.type],
      'retitling is not a lifecycle move and must not announce one',
    );

    const row = await statusOf(orgAId, id);
    assert.equal(row.title, 'Clearer title');
    assert.equal(row.impact, 'minor');
    assert.equal(row.status, 'investigating');
  });

  it('does not let another organization transition an incident', async () => {
    const id = await declare(cookieA, 'Guarded');

    const response = await transition(cookieB, id, 'identified');

    assert.equal(response.statusCode, 404, response.body);
    assert.equal((await statusOf(orgAId, id)).status, 'investigating');
  });
});
