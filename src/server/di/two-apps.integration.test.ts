import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { createService, declareIncident } from '@/shared/testing/fixtures';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Epic 9 retrospective, item 3 (DR-3): a second app in one process used to get
 * empty buses, because every app shared one DI container. The order matters:
 * awilix caches a singleton on first resolution, so A must be ready before B
 * is built for B to be the empty one.
 */

const tag = `two-apps-${randomBytes(4).toString('hex')}`;

let a: FastifyInstance;
let b: FastifyInstance;
let cookie = '';
let orgId = '';
let aClosed = false;

const page = (app: FastifyInstance) =>
  app.inject({ method: 'GET', url: `/status/${tag}` });

describe('Two apps in one process', () => {
  before(async () => {
    a = await buildApp({ logger: false });
    await a.ready();
    b = await buildApp({ logger: false });
    await b.ready();
    ({ cookie, orgId } = await signUpWithOrg(a, tag));
  });

  after(async () => {
    try {
      try {
        if (!aClosed) await a?.close();
      } finally {
        await b?.close();
      }
    } finally {
      try {
        if (orgId) await sql`delete from "organization" where "id" = ${orgId}`;
        await sql`delete from "user" where "email" = ${`${tag}@example.test`}`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  });

  it('gives each app its own container', () => {
    assert.notEqual(a.diContainer, b.diContainer);
  });

  it('answers a read through the second app', async () => {
    const res = await page(b);
    assert.equal(res.statusCode, 200, res.body);
  });

  it('answers a read through the first app', async () => {
    const res = await page(a);
    assert.equal(res.statusCode, 200, res.body);
  });

  it('runs a command through the second app', async () => {
    const id = await createService(b, cookie);
    const res = await b.inject({
      method: 'GET',
      url: `/api/v1/services/${id}`,
      headers: { cookie, origin: TEST_ORIGIN },
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  it('keeps the second app working after the first closes', async () => {
    aClosed = true;
    await a.close();

    const res = await page(b);
    assert.equal(res.statusCode, 200, res.body);
    const serviceId = await createService(b, cookie);

    // B's own event handlers must be subscribed on B's own event bus.
    await declareIncident(b, cookie, {
      impact: 'major',
      affectedServices: [{ serviceId, impact: 'major' }],
    });
    await b.eventBus.drain();
    const service = await b.inject({
      method: 'GET',
      url: `/api/v1/services/${serviceId}`,
      headers: { cookie, origin: TEST_ORIGIN },
    });
    assert.equal(service.statusCode, 200, service.body);
    assert.notEqual(JSON.parse(service.body).lastKnownStatus, 'operational');
  });
});
