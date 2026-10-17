import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sql from '@/shared/db/postgres';
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

async function post(
  app: FastifyInstance,
  cookie: string,
  serviceId: string,
  action: 'archive' | 'restore',
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/services/${serviceId}/${action}`,
    headers: { cookie, origin: TEST_ORIGIN },
  });
  assert.equal(response.statusCode, 200, response.body);
}

export const archiveService = (
  app: FastifyInstance,
  cookie: string,
  serviceId: string,
) => post(app, cookie, serviceId, 'archive');

export const restoreService = (
  app: FastifyInstance,
  cookie: string,
  serviceId: string,
) => post(app, cookie, serviceId, 'restore');

/**
 * Writes a monitor's check counters directly, for tests that need arbitrary
 * counters; a real check goes through `RecordCheckResultCommand`.
 * `lastCheckedAt` defaults to now, so the monitor counts as checked.
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

/**
 * Creates the `check_results` partitions from `from` (default: this month)
 * through the current month + 2. Safe under concurrent files: the function
 * takes an advisory lock and skips a partition that exists.
 */
export async function createCheckResultPartitions(from?: Date | string) {
  const fromDate =
    from instanceof Date ? from.toISOString().slice(0, 10) : (from ?? null);
  const rows = await sql<{ created: number }[]>`
    select public.create_check_result_partitions(${fromDate}::date) as created
  `;
  return rows[0].created;
}

/**
 * Stores one check result at `checkedAt`, creating its month's partition first
 * (a partition more than 13 months back is refused). Goes straight to the
 * table: the tests that need rollups want arbitrary results on arbitrary days,
 * not the counters `RecordCheckResultCommand` also moves.
 */
export async function insertCheckResult(
  orgId: string,
  result: {
    monitorId: string;
    serviceId: string;
    checkedAt: Date;
    status: 'success' | 'failure';
    latencyMs?: number | null;
  },
) {
  await createCheckResultPartitions(result.checkedAt);
  await withTenantTransaction(orgId, async ({ sql: tx }) => {
    await tx`
      insert into check_results (
        org_id, monitor_id, service_id, checked_at, status, latency_ms
      ) values (
        ${orgId}, ${result.monitorId}, ${result.serviceId}, ${result.checkedAt},
        ${result.status}, ${result.latencyMs ?? null}
      )
    `;
  });
}

let utcTodayPromise: Promise<Date> | undefined;

/**
 * Today's UTC date as a midnight `Date`, read from the database once, so every
 * "d-n" in a file derives from one clock. A run that straddles 00:00 UTC can
 * still flake, because the handler reads `now()` itself; that is accepted.
 */
export function utcToday(): Promise<Date> {
  utcTodayPromise ??= sql<{ today: string }[]>`
    select (now() at time zone 'UTC')::date::text as today
  `.then((rows) => new Date(`${rows[0].today}T00:00:00Z`));
  return utcTodayPromise;
}

/** Sets an organization's rollup watermark directly, to arrange a catch-up. */
export async function setRollupProgress(orgId: string, day: Date) {
  await withTenantTransaction(orgId, async ({ sql: tx }) => {
    await tx`
      insert into uptime_rollup_progress (org_id, refreshed_through)
      values (${orgId}, ${day.toISOString().slice(0, 10)}::date)
      on conflict (org_id) do update set
        refreshed_through = excluded.refreshed_through
    `;
  });
}
