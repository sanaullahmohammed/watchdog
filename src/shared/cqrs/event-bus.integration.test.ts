import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { serviceCreatedEvent } from '@/shared/events/service.events';

/**
 * Epic 2 retrospective, R-4: one failing event handler must not break a
 * command that has already committed, or the handlers registered after it.
 *
 * Exercised through a real route and the real bus the app builds, because the
 * failure this guards against was visible only there. The command committed,
 * then the emit threw, so the client got a 500 for a change that had happened.
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `ebi-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('Event handler isolation (Epic 2 retrospective, R-4)', () => {
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
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('keeps a committed command successful, and later handlers running, when a handler throws', async () => {
    const reached: string[] = [];
    app.eventBus.on(serviceCreatedEvent.type, () => {
      throw new Error('a listener exploded after the service was committed');
    });
    app.eventBus.on(serviceCreatedEvent.type, (event) => {
      reached.push((event.payload as { slug: string }).slug);
    });

    const slug = `${tag}-survives`;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { cookie, origin: ORIGIN },
      payload: { name: slug, slug },
    });

    assert.equal(
      response.statusCode,
      201,
      `the change was committed, so the client is told it succeeded: ${response.body}`,
    );
    assert.deepEqual(reached, [slug], 'the handler after the failing one ran');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: { cookie, origin: ORIGIN },
    });
    assert.ok(
      (JSON.parse(list.body) as { slug: string }[]).some(
        (service) => service.slug === slug,
      ),
    );
  });
});
