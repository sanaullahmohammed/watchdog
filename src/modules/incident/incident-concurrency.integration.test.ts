import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { canTransition } from '@/modules/incident/domain/incident.state-machine';
import type { IncidentStatus } from '@/modules/incident/domain/incident.types';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentResolvedEvent } from '@/shared/events/incident.events';

/**
 * Epic 2 retrospective, R-2 and R-3: concurrent writes to one incident.
 *
 * Each case fires requests at the same incident at once, through the real
 * routes, and asserts an invariant that holds only if they were serialized.
 * Without the row locks these fail intermittently rather than always: they
 * detect the race, they cannot force every interleaving. The cases that use
 * several rounds repeat for that reason.
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `cnc-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
const resolvedAnnounced: string[] = [];

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function declare(title: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: ORIGIN },
    payload: { title, impact: 'major' },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

function transition(id: string, status: IncidentStatus) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/incidents/${id}/transition`,
    headers: { cookie, origin: ORIGIN },
    payload: { status },
  });
}

function post(id: string, message: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/incidents/${id}/updates`,
    headers: { cookie, origin: ORIGIN },
    payload: { message },
  });
}

async function rowOf(id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<
      { status: IncidentStatus; resolved_at: Date | null }[]
    >`select status, resolved_at from incidents where id = ${id}`;
    return row;
  });
}

async function timelineStatuses(id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) =>
    (
      await tx<{ status: IncidentStatus }[]>`
        select status from incident_updates
        where incident_id = ${id}
        order by created_at, id
      `
    ).map((row) => row.status),
  );
}

/** A timeline is a legal walk: it opens at the declaration and every step is allowed. */
function assertLegalWalk(statuses: IncidentStatus[], label: string) {
  assert.equal(
    statuses[0],
    'investigating',
    `${label} opens at the declaration`,
  );
  for (let i = 1; i < statuses.length; i++) {
    const [from, to] = [statuses[i - 1], statuses[i]];
    // A posted update repeats the current status; a transition moves it.
    if (from === to) continue;
    assert.ok(
      canTransition(from, to),
      `${label}: timeline steps ${from} -> ${to}, which no transition allows (${statuses.join(' -> ')})`,
    );
  }
}

describe('Concurrent writes to one incident (Epic 2 retrospective, R-2 and R-3)', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    const email = `${tag}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: tag },
    });
    cookie = captureCookie(signUp.headers as Record<string, unknown>);
    [{ id: userId }] = await sql<{ id: string }[]>`
      select "id" from "user" where "email" = ${email}
    `;
    const org = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: { cookie, origin: ORIGIN },
      payload: { name: tag, slug: tag },
    });
    orgId = JSON.parse(org.body).id;

    app.eventBus.on(incidentResolvedEvent.type, (event) =>
      resolvedAnnounced.push((event.payload as { id: string }).id),
    );
  });

  after(async () => {
    // Transitions trigger status recomputation, which runs after the request
    // returns. Let it finish before the connection pool closes under it.
    await (
      app.diContainer.resolve(
        'recomputeServiceStatusEventHandler' as never,
      ) as { drain(): Promise<void> }
    ).drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('lets exactly one of several concurrent resolutions through', async () => {
    const id = await declare('Raced resolution');

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => transition(id, 'resolved')),
    );

    const accepted = responses.filter((r) => r.statusCode === 200);
    const refused = responses.filter((r) => r.statusCode !== 200);
    assert.equal(
      accepted.length,
      1,
      `expected one winner, got ${accepted.length}`,
    );
    assert.ok(
      refused.every((r) => r.statusCode >= 400 && r.statusCode < 500),
      'the others are refused as illegal moves out of resolved, not as server errors',
    );

    const statuses = await timelineStatuses(id);
    assert.equal(statuses.filter((s) => s === 'resolved').length, 1);
    assert.equal(resolvedAnnounced.filter((r) => r === id).length, 1);
  });

  it('never reopens a resolved incident when conflicting moves race', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await declare(`Conflicting moves ${round}`);
      const identified = await transition(id, 'identified');
      assert.equal(identified.statusCode, 200, identified.body);

      // Serialized, either order ends resolved: monitoring then resolved is a
      // legal walk, and resolved first makes monitoring illegal. Unserialized,
      // a monitoring write landing after the resolution reopens it.
      await Promise.all([
        transition(id, 'resolved'),
        transition(id, 'monitoring'),
      ]);

      const row = await rowOf(id);
      assert.equal(row.status, 'resolved', `round ${round}`);
      assert.notEqual(row.resolved_at, null, `round ${round}`);
      assertLegalWalk(await timelineStatuses(id), `round ${round}`);
    }
  });

  it('never records a status the incident had already left', async () => {
    for (let round = 0; round < 8; round++) {
      const id = await declare(`Update racing a move ${round}`);

      await Promise.all([
        post(id, 'Still looking into it'),
        transition(id, 'identified'),
      ]);

      // An "investigating" update after the move to identified is a timeline
      // that runs backwards.
      assertLegalWalk(await timelineStatuses(id), `round ${round}`);
    }
  });

  it('makes a posted update wait for an in-flight transition, then record its outcome', async () => {
    // Deterministic, unlike the race above. That interleaving almost never
    // lands by chance: the stale read has to be followed by a write that
    // arrives after the transition's own entry. So stage it. Hold the row lock
    // a transition takes, move the status without committing, and post
    // meanwhile.
    const id = await declare('Update behind a transition');

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const inFlight = withTenantTransaction(orgId, async ({ sql: tx }) => {
      await tx`select id from incidents where id = ${id} for no key update`;
      await tx`update incidents set status = 'identified' where id = ${id}`;
      signalLocked();
      await released;
    });
    await locked;

    let settled = false;
    const posting = post(id, 'Posted while a move was in flight').then(
      (response) => {
        settled = true;
        return response;
      },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        settled,
        false,
        'the update waits for the transition to commit rather than reading around it',
      );
    } finally {
      // Always let the held transaction finish. Otherwise a failure above
      // leaves it open, and every later cleanup waits on its lock forever.
      release();
      await inFlight;
    }
    const response = await posting;
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(
      (await timelineStatuses(id)).at(-1),
      'identified',
      'it records the status the transition committed',
    );
  });
});
