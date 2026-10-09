import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { env } from '@/config';
import { ownerDatabaseUrl } from '@/config/owner-env';
import {
  type MaintainCheckResultPartitionsCommandResult,
  maintainCheckResultPartitionsCommand,
} from '@/modules/monitoring/commands/maintain-check-result-partitions/maintain-check-result-partitions.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  createCheckResultPartitions,
  createMonitor,
  createService,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import { runWorkerPass } from '@/worker';

/**
 * Story 5.3: monthly partitions for check_results, created and dropped by two
 * owner-owned SECURITY DEFINER functions.
 *
 * Months 13 and 12 back belong to this suite alone: the retention test creates
 * from 13 back and passes a retention whose cutoff falls mid-month 11 back, so
 * only those two expire. Every other suite stores results 10 months back or
 * newer.
 */

const tag = `part-${randomBytes(4).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;
const silent = {
  info() {},
  warn() {},
  error() {},
} as never;

/** First instant (UTC) of the month `offset` months from this one. */
// Read from the database once, in `before`: the functions use its clock, not
// this process's.
let baseMonth = new Date();
let dbNow = new Date();
const monthStart = (offset: number) =>
  new Date(
    Date.UTC(baseMonth.getUTCFullYear(), baseMonth.getUTCMonth() + offset, 1),
  );
const nameOf = (date: Date) =>
  `check_results_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

let app: FastifyInstance;
let owner: postgres.Sql;
let orgId = '';
let otherOrgId = '';
let serviceId = '';
let monitorId = '';

const partitionExists = async (offset: number) => {
  const rows =
    await owner`select to_regclass(${`public.${nameOf(monthStart(offset))}`}) as r`;
  return rows[0].r !== null;
};

// The worker's command, with a retention long enough to drop nothing: the
// oldest month any test creates ends about 12 months back.
const maintain = () =>
  app.commandBus.execute<MaintainCheckResultPartitionsCommandResult>(
    maintainCheckResultPartitionsCommand({ retentionDays: 400 }),
  );

const sqlState = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: { code?: string }) => error.code === code);

const insertRow = (checkedAt: Date) =>
  owner`
    insert into check_results (org_id, monitor_id, service_id, checked_at, status)
    values (${orgId}, ${monitorId}, ${serviceId}, ${checkedAt}, 'success')
  `;

describe('Story 5.3: check_results partitions', () => {
  before(async () => {
    owner = postgres(ownerDatabaseUrl(), { max: 1 });
    const [clock] = await owner<{ m: Date; n: Date }[]>`
      select date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' as m,
        now() as n
    `;
    baseMonth = clock.m;
    dbNow = clock.n;
    app = await buildApp({ logger: false });
    await app.ready();
    const org = await signUpWithOrg(app, tag);
    orgId = org.orgId;
    otherOrgId = (await signUpWithOrg(app, `${tag}-b`)).orgId;
    serviceId = await createService(app, org.cookie);
    monitorId = await createMonitor(app, org.cookie, serviceId);
  });

  after(async () => {
    await app.close();
    await owner.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it('has the current month and the next two after the first pass', async () => {
    await maintain();
    for (const offset of [0, 1, 2]) {
      assert.equal(await partitionExists(offset), true, `month +${offset}`);
    }
  });

  it('creates nothing on a second pass', async () => {
    await maintain();
    assert.equal((await maintain()).created, 0);
  });

  it('stores a row through the parent as the application role', async () => {
    await withTenantTransaction(orgId, async ({ sql: tx }) => {
      await tx`
        insert into check_results (org_id, monitor_id, service_id, checked_at, status)
        values (${orgId}, ${monitorId}, ${serviceId}, now(), 'failure')
      `;
      const rows = await tx`select id from check_results`;
      assert.ok(rows.length >= 1);
    });
    const countFor = (as: string, of: string) =>
      withTenantTransaction(as, async ({ sql: tx }) => {
        const [{ count }] = await tx<{ count: number }[]>`
          select count(*)::int as count from check_results where org_id = ${of}
        `;
        return count;
      });
    assert.ok((await countFor(orgId, orgId)) >= 1);
    assert.equal(await countFor(otherOrgId, orgId), 0);
  });

  it('refuses a start more than 13 months back, creating nothing', async () => {
    const count = async () =>
      (
        await owner<{ n: number }[]>`
          select count(*)::int as n from pg_inherits
          where inhparent = 'public.check_results'::regclass
        `
      )[0].n;
    const before = await count();
    await sqlState(createCheckResultPartitions(monthStart(-14)), '22023');
    assert.equal(await count(), before);
  });

  it('starts from a mid-month date 13 months back', async () => {
    const mid = new Date(monthStart(-13).getTime() + 10 * DAY);
    await createCheckResultPartitions(mid);
    assert.equal(await partitionExists(-13), true);
    assert.equal(await partitionExists(-12), true);
    assert.equal(await partitionExists(0), true);
  });

  it('refuses a bad retention and drops nothing', async () => {
    for (const bad of [0, -1, null]) {
      await sqlState(
        sql`select public.drop_expired_check_result_partitions(${bad}::int)`,
        '22023',
      );
    }
    assert.equal(await partitionExists(-13), true);
  });

  it('refuses direct access to a partition and any update or delete', async () => {
    const partition = nameOf(monthStart(0));
    await sqlState(sql`select 1 from ${sql(partition)} limit 1`, '42501');
    await sqlState(
      sql`insert into ${sql(partition)} (org_id, monitor_id, service_id, checked_at, status)
          values (${orgId}, ${monitorId}, ${serviceId}, now(), 'success')`,
      '42501',
    );
    await sqlState(
      withTenantTransaction(
        orgId,
        ({ sql: tx }) => tx`update check_results set status = 'success'`,
      ),
      '42501',
    );
    await sqlState(
      withTenantTransaction(
        orgId,
        ({ sql: tx }) => tx`delete from check_results`,
      ),
      '42501',
    );
  });

  it('gives each partition RLS, forced, and a policy', async () => {
    const rows = await owner<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policies: number;
      }[]
    >`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.check_results'::regclass
    `;
    assert.ok(rows.length >= 3);
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, true, row.relname);
      assert.equal(row.policies, 1, row.relname);
    }
  });

  it('exposes exactly the two definer functions to the application role', async () => {
    const [{ me }] = await owner<{ me: string }[]>`select current_user as me`;
    const rows = await owner<
      {
        proname: string;
        owner: string;
        prosecdef: boolean;
        proconfig: string[];
        args: string;
        prosrc: string;
      }[]
    >`
      select proname, pg_get_userbyid(proowner) as owner, prosecdef, proconfig,
        pg_get_function_identity_arguments(oid) as args, prosrc
      from pg_proc
      where pronamespace = 'public'::regnamespace
        and has_function_privilege('watchdog_app', oid, 'execute')
      order by proname
    `;
    assert.deepEqual(
      rows.map((row) => [row.proname, row.args]),
      [
        ['create_check_result_partitions', 'p_from date'],
        ['drop_expired_check_result_partitions', 'p_retention_days integer'],
      ],
    );
    for (const row of rows) {
      assert.equal(row.owner, me);
      assert.equal(row.prosecdef, true);
      assert.ok(
        row.proconfig.some((c) => c.startsWith('search_path=pg_catalog')),
      );
      assert.ok(!/delete/i.test(row.prosrc), row.proname);
    }
  });

  it('drops only expired partitions, one of which held a row', async () => {
    await createCheckResultPartitions(monthStart(-13));
    await insertRow(new Date(monthStart(-13).getTime() + 5 * DAY));
    const cutoff = monthStart(-11).getTime() + 14 * DAY;
    const retentionDays = Math.ceil((dbNow.getTime() - cutoff) / DAY);

    const { dropped } =
      await app.commandBus.execute<MaintainCheckResultPartitionsCommandResult>(
        maintainCheckResultPartitionsCommand({ retentionDays }),
      );
    assert.ok(dropped >= 2);
    assert.equal(await partitionExists(-13), false);
    assert.equal(await partitionExists(-12), false);
    assert.equal(await partitionExists(-11), true);
    assert.equal(await partitionExists(0), true);
  });

  it('does not hold check_results while creation waits on another lock', async () => {
    assert.equal(await partitionExists(-13), false);
    assert.equal(await partitionExists(-12), false);
    let creating: Promise<number> | undefined;
    await owner.begin(async (trx) => {
      const tx = trx as unknown as postgres.Sql;
      await tx`lock table "organization" in row exclusive mode`;
      creating = createCheckResultPartitions(monthStart(-13));
      creating.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx`set local lock_timeout = '1s'`;
      await tx`lock table check_results in row exclusive mode`;
    });
    assert.equal(await creating, 2);
  });

  it('takes no table lock when every partition exists', async () => {
    const started = Date.now();
    await assert.rejects(
      owner.begin(async (trx) => {
        const tx = trx as unknown as postgres.Sql;
        await tx`lock table monitors, check_results in row exclusive mode`;
        assert.equal(await createCheckResultPartitions(), 0);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.ok(Date.now() - started < 1_500);
  });

  describe('the worker pass', () => {
    type Repo = {
      createPartitions: (...a: unknown[]) => Promise<number>;
      dropExpired: (...a: unknown[]) => Promise<number>;
    };
    const stubbed = async (
      createPartitions: Repo['createPartitions'],
      run: () => Promise<void>,
    ) => {
      const repo = app.diContainer.resolve(
        'checkResultPartitionRepository' as never,
      ) as Repo;
      const original = { ...repo };
      repo.createPartitions = createPartitions;
      repo.dropExpired = async () => 0;
      try {
        await run();
      } finally {
        Object.assign(repo, original);
      }
    };
    const logger = () => {
      const errors: unknown[] = [];
      return {
        errors,
        log: {
          info() {},
          warn() {},
          error: (obj: unknown) => errors.push(obj),
        } as never,
      };
    };

    it('logs a maintenance failure with err and rejects', async () => {
      const { errors, log } = logger();
      const boom = new Error('ddl refused');
      await stubbed(
        async () => {
          throw boom;
        },
        async () => {
          await assert.rejects(
            runWorkerPass(app, log, {
              orgIds: [orgId],
              maintainPartitions: true,
            }),
            (error: Error) =>
              error.message === 'check result partition maintenance failed' &&
              error.cause === undefined,
          );
        },
      );
      assert.equal(errors.length, 1);
      assert.equal((errors[0] as { err: unknown }).err, boom);
    });

    it('runs maintenance once, last, with the configured retention, on the worker call shape', async () => {
      const seen: { type: string; payload: Record<string, unknown> }[] = [];
      const stubApp = {
        commandBus: {
          async execute(command: {
            type: string;
            payload: Record<string, unknown>;
          }) {
            seen.push({ type: command.type, payload: command.payload });
            // Module command types are strings; importing the creators would
            // cross module boundaries. An unknown type fails the pass, so a
            // renamed command cannot slip through as the partition result.
            if (command.type === 'maintenance/transition_due')
              return { started: 0, completed: 0 };
            if (command.type === 'service/status.reconcile') return [];
            if (command.type === maintainCheckResultPartitionsCommand.type)
              return { created: 0, dropped: 0 };
            throw new Error(`unexpected command ${command.type}`);
          },
        },
      } as unknown as Parameters<typeof runWorkerPass>[0];

      await runWorkerPass(stubApp, silent);

      const partition = maintainCheckResultPartitionsCommand.type;
      const indexes = seen
        .map((c, i) => (c.type === partition ? i : -1))
        .filter((i) => i >= 0);
      assert.deepEqual(indexes, [seen.length - 1]);
      assert.ok(seen.length > 1, 'organization commands ran first');
      assert.equal(
        seen[seen.length - 1].payload.retentionDays,
        env.monitor.checkResultsRetentionDays,
      );
    });

    it('skips maintenance on a scoped pass', async () => {
      let calls = 0;
      await stubbed(
        async () => {
          calls += 1;
          return 0;
        },
        () => runWorkerPass(app, silent, { orgIds: [orgId] }),
      );
      assert.equal(calls, 0);
    });

    it('still runs maintenance once when every organization fails', async () => {
      let calls = 0;
      await stubbed(
        async () => {
          calls += 1;
          return 0;
        },
        async () => {
          await assert.rejects(
            runWorkerPass(app, silent, {
              orgIds: ['not a valid id!'],
              maintainPartitions: true,
            }),
            /every organization failed/,
          );
        },
      );
      assert.equal(calls, 1);
    });
  });
});
