import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import config from '@/config/env';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  archiveService,
  createCheckResultPartitions,
  createMonitor,
  createService,
  restoreService,
  setMonitorCheckState,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import {
  startTestEndpoints,
  type TestEndpoints,
} from '@/shared/testing/test-endpoints';
import {
  type RunDueMonitorChecksCommandResult,
  runDueMonitorChecksCommand,
} from './commands/run-due-monitor-checks/run-due-monitor-checks.handler';

/**
 * Story 5.8: find and run the checks that are due. Each test runs the command
 * for an organization of its own, because the command visits every due monitor
 * of one, and never orders by time (AGENTS.md clock skew).
 */

const tag = `due-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let endpoints: TestEndpoints;
const savedCidrs = config.monitor.allowedCidrs;
const savedConcurrency = config.monitor.checkConcurrency;
const orgs: { orgId: string; userId: string }[] = [];
let counter = 0;

type Org = { cookie: string; orgId: string; serviceId: string };

async function newOrg(): Promise<Org> {
  counter += 1;
  const { cookie, orgId, userId } = await signUpWithOrg(
    app,
    `${tag}-${counter}`,
  );
  orgs.push({ orgId, userId });
  return { cookie, orgId, serviceId: await createService(app, cookie) };
}

const run = (orgId: string, now?: Date) =>
  app.commandBus.execute<RunDueMonitorChecksCommandResult>(
    runDueMonitorChecksCommand({ orgId, now }),
  );

type ResultRow = {
  status: string;
  error_code: string | null;
  metadata: Record<string, unknown>;
};

async function results(orgId: string, monitorId: string) {
  return withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<ResultRow[]>`
        select status, error_code, metadata from check_results
        where monitor_id = ${monitorId}
      `,
  );
}

const make = (org: Org, overrides: object = {}) =>
  createMonitor(app, org.cookie, org.serviceId, {
    intervalSeconds: 60,
    target: `${endpoints.origin}/ok`,
    ...overrides,
  });

async function xmin(orgId: string, monitorId: string) {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ x: string }[]>`
        select xmin::text as x from monitors where id = ${monitorId}
      `,
  );
  return rows[0].x;
}

describe('Story 5.8: find and run the checks that are due', () => {
  before(async () => {
    config.monitor.allowedCidrs = parseAllowedCidrs('127.0.0.0/8');
    endpoints = await startTestEndpoints();
    app = await buildApp({ logger: false });
    await app.ready();
    await createCheckResultPartitions();
  });

  after(async () => {
    config.monitor.allowedCidrs = savedCidrs;
    config.monitor.checkConcurrency = savedConcurrency;
    await app.eventBus.drain();
    for (const { orgId, userId } of orgs) {
      await sql`delete from "organization" where "id" = ${orgId}`;
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await endpoints.close();
    await sql.end({ timeout: 5 });
  });

  it('checks the due monitors and leaves the others alone', async () => {
    const org = await newOrg();
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms);
    const a = await make(org);
    const b = await make(org);
    const c = await make(org);
    const d = await make(org, { enabled: false });
    const e = await make(org);
    await setMonitorCheckState(org.orgId, a, {
      consecutiveFailures: 0,
      lastCheckedAt: at(60_000),
    });
    await setMonitorCheckState(org.orgId, b, {
      consecutiveFailures: 0,
      lastCheckedAt: at(59_999),
    });
    await setMonitorCheckState(org.orgId, e, {
      consecutiveFailures: 0,
      lastCheckedAt: at(3_600_000),
    });
    await setMonitorCheckState(org.orgId, c, {
      consecutiveFailures: 0,
      lastCheckedAt: null,
    });

    assert.deepEqual(await run(org.orgId, now), { checked: 3 });
    for (const id of [a, c, e])
      assert.equal((await results(org.orgId, id)).length, 1);
    for (const id of [b, d])
      assert.equal((await results(org.orgId, id)).length, 0);
  });

  it('runs the adapter for every monitor type', async () => {
    const org = await newOrg();
    const http = await make(org);
    const keyword = await make(org, {
      type: 'keyword',
      target: `${endpoints.origin}/body?size=100&keyword=needle&at=10`,
      config: { keyword: 'needle' },
    });
    const tcp = await make(org, {
      type: 'tcp',
      target: `127.0.0.1:${endpoints.port}`,
    });
    const ssl = await make(org, {
      type: 'ssl_expiry',
      target: `127.0.0.1:${new URL(endpoints.httpsOrigin).port}`,
      config: { warnDays: 30 },
    });

    assert.deepEqual(await run(org.orgId), { checked: 4 });
    for (const id of [http, keyword, tcp]) {
      const [row] = await results(org.orgId, id);
      assert.equal(row.status, 'success', JSON.stringify(row));
    }
    const [sslRow] = await results(org.orgId, ssl);
    assert.equal(sslRow.status, 'failure');
    assert.equal(sslRow.error_code, 'certificate_untrusted');
    assert.ok(sslRow.metadata.certificateFingerprint);
  });

  it('skips the monitors of an archived service', async () => {
    const org = await newOrg();
    const enabled = await make(org);
    const disabled = await make(org, { enabled: false });
    await archiveService(app, org.cookie, org.serviceId);
    const before = [
      await xmin(org.orgId, enabled),
      await xmin(org.orgId, disabled),
    ];

    assert.deepEqual(await run(org.orgId), { checked: 0 });
    for (const id of [enabled, disabled]) {
      assert.equal((await results(org.orgId, id)).length, 0);
    }
    assert.deepEqual(
      [await xmin(org.orgId, enabled), await xmin(org.orgId, disabled)],
      before,
    );
  });

  it('resumes the enabled monitors of a restored service', async () => {
    const org = await newOrg();
    const now = new Date();
    const fresh = await make(org);
    const recent = await make(org);
    const disabled = await make(org, { enabled: false });
    await setMonitorCheckState(org.orgId, recent, {
      consecutiveFailures: 0,
      lastCheckedAt: new Date(now.getTime() - 10_000),
    });
    await archiveService(app, org.cookie, org.serviceId);
    await restoreService(app, org.cookie, org.serviceId);

    assert.deepEqual(await run(org.orgId, now), { checked: 1 });
    assert.equal((await results(org.orgId, fresh)).length, 1);
    assert.equal((await results(org.orgId, recent)).length, 0);

    await setMonitorCheckState(org.orgId, recent, {
      consecutiveFailures: 0,
      lastCheckedAt: new Date(now.getTime() - 60_000),
    });
    assert.deepEqual(await run(org.orgId, now), { checked: 1 });
    assert.equal((await results(org.orgId, recent)).length, 1);
    assert.equal((await results(org.orgId, fresh)).length, 1);
    assert.equal((await results(org.orgId, disabled)).length, 0);
  });

  it('never runs more checks at once than the cap, across organizations', async () => {
    const first = await newOrg();
    const second = await newOrg();
    const placed: [Org, string][] = [];
    for (const org of [first, first, first, second, second]) {
      placed.push([
        org,
        await make(org, { target: `${endpoints.origin}/hold?delay=400` }),
      ]);
    }
    config.monitor.checkConcurrency = 2;
    endpoints.reset();
    try {
      const counts = await Promise.all([run(first.orgId), run(second.orgId)]);
      assert.deepEqual(counts, [{ checked: 3 }, { checked: 2 }]);
    } finally {
      config.monitor.checkConcurrency = savedConcurrency;
    }
    assert.equal(endpoints.peakInFlight(), 2);
    for (const [org, id] of placed) {
      assert.equal((await results(org.orgId, id)).length, 1);
    }
  });

  it('holds a slot until the record settles', async () => {
    const org = await newOrg();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await make(org));
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: unknown) => Promise<string>;
    };
    const original = repo.append;
    let inFlight = 0;
    let peak = 0;
    repo.append = async (tx, row) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return await original.call(repo, tx, row);
      } finally {
        inFlight -= 1;
      }
    };
    config.monitor.checkConcurrency = 2;
    try {
      assert.deepEqual(await run(org.orgId), { checked: 5 });
    } finally {
      repo.append = original;
      config.monitor.checkConcurrency = savedConcurrency;
    }
    assert.equal(peak, 2);
    for (const id of ids)
      assert.equal((await results(org.orgId, id)).length, 1);
  });

  it('records a timeout without holding up the others', async () => {
    const org = await newOrg();
    const silent = await make(org, {
      target: `${endpoints.origin}/silent`,
      timeoutSeconds: 1,
    });
    const ok = [await make(org), await make(org)];

    const started = performance.now();
    assert.deepEqual(await run(org.orgId), { checked: 3 });
    assert.ok(performance.now() - started < 5_000);

    const [row] = await results(org.orgId, silent);
    assert.equal(row.status, 'failure');
    assert.equal(row.error_code, 'timeout');
    for (const id of ok) {
      assert.equal((await results(org.orgId, id))[0].status, 'success');
    }
  });

  it('records the others when one record rejects, then rethrows', async () => {
    const org = await newOrg();
    const ids = [await make(org), await make(org), await make(org)];
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: { monitorId: string }) => Promise<string>;
    };
    const original = repo.append;
    const failure = new Error('append failed');
    repo.append = (tx, row) =>
      row.monitorId === ids[1]
        ? Promise.reject(failure)
        : original.call(repo, tx, row);
    try {
      await assert.rejects(run(org.orgId), (error) => error === failure);
    } finally {
      repo.append = original;
    }
    assert.equal((await results(org.orgId, ids[0])).length, 1);
    assert.equal((await results(org.orgId, ids[1])).length, 0);
    assert.equal((await results(org.orgId, ids[2])).length, 1);
  });

  it('rethrows every reason when several records reject', async () => {
    const org = await newOrg();
    const ids = [await make(org), await make(org), await make(org)];
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: { monitorId: string }) => Promise<string>;
    };
    const original = repo.append;
    const errors = [new Error('first'), new Error('second')];
    repo.append = (tx, row) => {
      const at = [ids[0], ids[1]].indexOf(row.monitorId);
      return at >= 0
        ? Promise.reject(errors[at])
        : original.call(repo, tx, row);
    };
    try {
      await assert.rejects(run(org.orgId), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.deepEqual([...error.errors].sort(), [...errors].sort());
        return true;
      });
    } finally {
      repo.append = original;
    }
    assert.equal((await results(org.orgId, ids[2])).length, 1);
  });

  it("leaves another organization's monitors alone", async () => {
    const mine = await newOrg();
    const theirs = await newOrg();
    await make(mine);
    const other = await make(theirs);

    assert.deepEqual(await run(mine.orgId), { checked: 1 });
    assert.equal((await results(theirs.orgId, other)).length, 0);
  });
});
