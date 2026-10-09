import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
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

/**
 * An enabled http monitor on `serviceId`. The target is a TEST-NET-3 literal
 * (203.0.113.0/24), which the courtesy check accepts without a DNS lookup.
 */
export function createMonitor(
  app: FastifyInstance,
  cookie: string,
  serviceId: string,
  overrides: object = {},
) {
  return create(app, cookie, '/monitors', {
    serviceId,
    type: 'http',
    name: unique('mon'),
    target: 'https://203.0.113.10/health',
    ...overrides,
  });
}

/**
 * Writes a monitor's check counters directly, standing in for a check until
 * story 5.6 records them. `lastCheckedAt` defaults to now, so the monitor
 * counts as checked.
 */
export async function setMonitorCheckState(
  orgId: string,
  monitorId: string,
  state: {
    consecutiveFailures: number;
    failureEpisode?: number;
    lastCheckedAt?: Date | null;
  },
) {
  await withTenantTransaction(orgId, async ({ sql }) => {
    const rows = await sql`
      update monitors set
        consecutive_failures = ${state.consecutiveFailures},
        failure_episode = coalesce(${state.failureEpisode ?? null}, failure_episode),
        last_checked_at = ${state.lastCheckedAt === undefined ? new Date() : state.lastCheckedAt}
      where id = ${monitorId}
      returning id
    `;
    assert.equal(rows.length, 1, `monitor ${monitorId} not found`);
  });
}
