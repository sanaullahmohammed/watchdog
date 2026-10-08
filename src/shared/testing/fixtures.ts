import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Fresh records made through the REST surface, each returning its id.
 *
 * Several mutations answer `false` when they change nothing, so a test that
 * needs a success makes its own record rather than sharing one. Slugs and
 * titles are unique per call.
 */

const HOUR = 60 * 60 * 1000;

const unique = (label: string) => `${label}-${randomBytes(4).toString('hex')}`;

async function create(
  app: FastifyInstance,
  cookie: string,
  url: string,
  payload: object,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

export function createService(
  app: FastifyInstance,
  cookie: string,
  overrides: object = {},
) {
  const slug = unique('svc');
  return create(app, cookie, '/services', { name: slug, slug, ...overrides });
}

export function createServiceGroup(
  app: FastifyInstance,
  cookie: string,
  overrides: object = {},
) {
  const slug = unique('grp');
  return create(app, cookie, '/service-groups', {
    name: slug,
    slug,
    ...overrides,
  });
}

export function declareIncident(
  app: FastifyInstance,
  cookie: string,
  overrides: object = {},
) {
  return create(app, cookie, '/incidents', {
    title: unique('incident'),
    impact: 'minor',
    ...overrides,
  });
}

/** A window that starts in an hour, so it stays `scheduled`. */
export function scheduleMaintenance(
  app: FastifyInstance,
  cookie: string,
  overrides: object = {},
) {
  return create(app, cookie, '/maintenance', {
    title: unique('window'),
    scheduledStartAt: new Date(Date.now() + HOUR).toISOString(),
    scheduledEndAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    ...overrides,
  });
}
