import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { env } from '@/config';
import {
  type PruneNotificationsCommandResult,
  pruneNotificationsCommand,
} from '@/modules/notification/commands/prune-notifications/prune-notifications.handler';
import subscriberRepository from '@/modules/notification/database/subscriber.repository';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { holdTransaction, waitUntilBlockedBy } from '@/shared/testing/locks';
import { signUpWithOrg } from '@/shared/testing/tenant';
import { runNotificationPass } from '@/worker';

/**
 * Story 6.9: prune old deliveries and subscribers.
 *
 * Rows are aged in SQL with the prune's own interval expression, from the
 * settings, never a hard-coded 90 or 7 and never JS milliseconds. Every pass
 * is scoped to the test's organizations with `{ orgIds }`.
 *
 * Sabotage this suite must catch (spec 6.9, AC):
 * - no status filter on deliveries: "keeps a pending delivery however old";
 * - a cutoff one day short, in each rule: "keeps a delivery just inside
 *   retention", "keeps a subscriber unsubscribed just inside retention",
 *   "keeps a pending subscriber just inside its grace";
 * - no `least` with the cursor: "keeps a delivery the cursor's window still
 *   covers";
 * - no `status = 'pending'` on never-confirmed: "keeps a confirmed
 *   subscriber, whatever its timestamps";
 * - the prune removed from the pass: "goes through the pass";
 * - ids read without a lock, then `delete ... where id = any(ids)` with no
 *   rule in the delete, in the unsubscribed rule: "survives a resubscribe that
 *   holds the row (unsubscribed)"; in the never-confirmed rule: "... (pending)";
 * - dropping `updated_at = now()` from `unsubscribe`: "keeps a subscriber
 *   unsubscribed through the code";
 * - `failed.add` or the log removed from the pass's prune catch: "a prune
 *   failure counts toward every organization failed";
 * - the `signal` check removed: "skips the prune once the signal aborts";
 * - one line per organization: "logs one line for the whole pass".
 */

const tag = `prune-${randomBytes(4).toString('hex')}`;
const retention = env.notification.retentionDays;
const grace = env.subscribe.pendingGraceDays;
const MINUTE = `interval '1 minute'`;

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];
let counter = 0;

const infos: { obj: Record<string, unknown>; msg: string }[] = [];
const errors: unknown[] = [];
const errorMessages: string[] = [];
const logger = {
  info(obj: Record<string, unknown>, msg: string) {
    infos.push({ obj, msg });
  },
  warn() {},
  error(obj: unknown, msg?: string) {
    errors.push(obj);
    if (msg !== undefined) errorMessages.push(msg);
  },
} as unknown as FastifyBaseLogger;

async function newOrg(): Promise<string> {
  counter += 1;
  const { orgId, userId } = await signUpWithOrg(app, `${tag}-${counter}`);
  created.push({ orgId, userId });
  return orgId;
}

const prune = (orgId: string) =>
  app.commandBus.execute<PruneNotificationsCommandResult>(
    pruneNotificationsCommand({ orgId }),
  );

const none = { deliveries: 0, unsubscribed: 0, neverConfirmed: 0 };

/** `now() - retention days`, a minute before (`'-'`) or after (`'+'`) it. */
const retentionAge = (sign: '+' | '-') =>
  sql.unsafe(`now() - make_interval(days => ${retention}) ${sign} ${MINUTE}`);
const graceAge = (sign: '+' | '-') =>
  sql.unsafe(`now() - make_interval(days => ${grace}) ${sign} ${MINUTE}`);

// "Older" by a minute is `age('-')`, i.e. before the cutoff; "inside" is '+'.
type Age = ReturnType<typeof retentionAge>;

async function insertSubscriber(
  orgId: string,
  status: 'pending' | 'confirmed' | 'unsubscribed',
  at: { updated?: Age; expires?: Age },
  email = `${randomBytes(6).toString('hex')}@example.test`,
): Promise<string> {
  const [row] = await withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<{ id: string }[]>`
      insert into subscribers (
        org_id, email, status, confirmation_expires_at, updated_at
      ) values (
        ${orgId}, ${email}, ${status},
        ${at.expires ?? null}, coalesce(${at.updated ?? null}, now())
      )
      returning id
    `,
  );
  return row.id;
}

async function insertDelivery(
  orgId: string,
  subscriberId: string,
  status: 'pending' | 'sent' | 'failed' | 'abandoned',
  createdAt: Age,
): Promise<string> {
  const [row] = await withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<{ id: string }[]>`
      insert into notification_deliveries (
        org_id, subscriber_id, source_type, source_id, status, created_at
      ) values (
        ${orgId}, ${subscriberId}, 'incident_update', ${randomUUID()},
        ${status}, ${createdAt}
      )
      returning id
    `,
  );
  return row.id;
}

const deliveryIds = (orgId: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) =>
    (await tx<{ id: string }[]>`select id from notification_deliveries`).map(
      (row) => row.id,
    ),
  );

const subscriberIds = (orgId: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) =>
    (await tx<{ id: string }[]>`select id from subscribers`).map(
      (row) => row.id,
    ),
  );

const subscriberStatus = (orgId: string, id: string) =>
  withTenantTransaction(
    orgId,
    async ({ sql: tx }) =>
      (
        await tx<{ status: string }[]>`
          select status from subscribers where id = ${id}
        `
      )[0]?.status,
  );

describe('Story 6.9: prune old deliveries and subscribers', () => {
  before(async () => {
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    for (const { orgId, userId } of created) {
      await sql`delete from "organization" where "id" = ${orgId}`;
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('deletes sent, failed and abandoned deliveries past retention', async () => {
    const orgId = await newOrg();
    const subscriber = await insertSubscriber(orgId, 'confirmed', {});
    for (const status of ['sent', 'failed', 'abandoned'] as const) {
      await insertDelivery(orgId, subscriber, status, retentionAge('-'));
    }
    assert.deepEqual(await prune(orgId), {
      deliveries: 3,
      unsubscribed: 0,
      neverConfirmed: 0,
    });
    assert.deepEqual(await deliveryIds(orgId), []);
    assert.deepEqual(await subscriberIds(orgId), [subscriber]);
  });

  it('keeps a delivery just inside retention', async () => {
    const orgId = await newOrg();
    const subscriber = await insertSubscriber(orgId, 'confirmed', {});
    const kept = await insertDelivery(
      orgId,
      subscriber,
      'sent',
      retentionAge('+'),
    );
    assert.deepEqual(await prune(orgId), none);
    assert.deepEqual(await deliveryIds(orgId), [kept]);
  });

  it('keeps a delivery the cursor window still covers', async () => {
    const orgId = await newOrg();
    const subscriber = await insertSubscriber(orgId, 'confirmed', {});
    const kept = await insertDelivery(
      orgId,
      subscriber,
      'sent',
      retentionAge('-'),
    );
    // read_at is taken from the delivery's own row, half the overlap after it:
    // the delivery is inside the re-read window only through the overlap.
    await withTenantTransaction(
      orgId,
      ({ sql: tx }) => tx`
        insert into notification_cursors (org_id, read_at)
        values (${orgId}, now())
        on conflict (org_id) do nothing
      `,
    );
    await withTenantTransaction(
      orgId,
      ({ sql: tx }) => tx`
        update notification_cursors
        set read_at = (
          select created_at from notification_deliveries where id = ${kept}
        ) + make_interval(secs => ${env.notification.cursorOverlapSeconds / 2})
        where org_id = ${orgId}
      `,
    );
    assert.deepEqual(await prune(orgId), none);
    assert.deepEqual(await deliveryIds(orgId), [kept]);
  });

  it('keeps a pending delivery however old', async () => {
    const orgId = await newOrg();
    const subscriber = await insertSubscriber(orgId, 'confirmed', {});
    const kept = await insertDelivery(
      orgId,
      subscriber,
      'pending',
      sql.unsafe(`now() - make_interval(days => ${retention + 1})`),
    );
    assert.deepEqual(await prune(orgId), none);
    assert.deepEqual(await deliveryIds(orgId), [kept]);
  });

  it('deletes an unsubscribed subscriber past retention with its deliveries', async () => {
    const orgId = await newOrg();
    const gone = await insertSubscriber(orgId, 'unsubscribed', {
      updated: retentionAge('-'),
    });
    await insertDelivery(orgId, gone, 'sent', retentionAge('+'));
    const result = await prune(orgId);
    assert.equal(result.unsubscribed, 1);
    assert.deepEqual(await subscriberIds(orgId), []);
    assert.deepEqual(await deliveryIds(orgId), []);
  });

  it('keeps a subscriber unsubscribed just inside retention', async () => {
    const orgId = await newOrg();
    const kept = await insertSubscriber(orgId, 'unsubscribed', {
      updated: retentionAge('+'),
    });
    assert.deepEqual(await prune(orgId), none);
    assert.deepEqual(await subscriberIds(orgId), [kept]);
  });

  it('deletes a pending subscriber past its grace, and keeps one inside it', async () => {
    const orgId = await newOrg();
    await insertSubscriber(orgId, 'pending', { expires: graceAge('-') });
    const kept = await insertSubscriber(orgId, 'pending', {
      expires: graceAge('+'),
    });
    assert.equal((await prune(orgId)).neverConfirmed, 1);
    assert.deepEqual(await subscriberIds(orgId), [kept]);
  });

  it('keeps a confirmed subscriber, whatever its timestamps', async () => {
    const orgId = await newOrg();
    const year = sql.unsafe(`now() - interval '1 year'`);
    const kept = await insertSubscriber(orgId, 'confirmed', {
      updated: year,
      expires: year,
    });
    const pending = await insertDelivery(orgId, kept, 'pending', year);
    assert.deepEqual(await prune(orgId), {
      deliveries: 0,
      unsubscribed: 0,
      neverConfirmed: 0,
    });
    assert.deepEqual(await subscriberIds(orgId), [kept]);
    assert.deepEqual(await deliveryIds(orgId), [pending]);
  });

  it('deletes a once-confirmed pending subscriber with its final deliveries', async () => {
    const orgId = await newOrg();
    const repository = subscriberRepository();
    const email = `${randomBytes(6).toString('hex')}@example.test`;
    const tokenHash = randomBytes(8).toString('hex');
    const request = (hash: string) =>
      withTenantTransaction(orgId, (tx) =>
        repository.requestConfirmation(tx, {
          email,
          tokenHash: hash,
          ttlHours: 24,
          resendSeconds: 0,
        }),
      );
    const { subscriberId } = await request(tokenHash);
    await withTenantTransaction(orgId, (tx) =>
      repository.confirm(tx, tokenHash),
    );
    await withTenantTransaction(orgId, (tx) =>
      repository.unsubscribe(tx, subscriberId),
    );
    const again = await request(randomBytes(8).toString('hex'));
    assert.equal(again.outcome, 'returned');
    assert.equal(again.subscriberId, subscriberId);
    await withTenantTransaction(
      orgId,
      ({ sql: tx }) => tx`
        update subscribers
        set confirmation_expires_at = ${graceAge('-')}
        where id = ${subscriberId}
      `,
    );
    await insertDelivery(orgId, subscriberId, 'sent', retentionAge('+'));
    assert.deepEqual(await prune(orgId), {
      deliveries: 0,
      unsubscribed: 0,
      neverConfirmed: 1,
    });
    assert.deepEqual(await subscriberIds(orgId), []);
    assert.deepEqual(await deliveryIds(orgId), []);
  });

  it('keeps a subscriber unsubscribed through the code', async () => {
    const orgId = await newOrg();
    const old = retentionAge('-');
    const id = await insertSubscriber(orgId, 'confirmed', { updated: old });
    await withTenantTransaction(orgId, (tx) =>
      subscriberRepository().unsubscribe(tx, id),
    );
    assert.equal(await subscriberStatus(orgId, id), 'unsubscribed');
    assert.deepEqual(await prune(orgId), none);
    assert.deepEqual(await subscriberIds(orgId), [id]);
  });

  // The holder reissues `kind`'s row through requestConfirmation; the prune
  // must be seen blocked on it before the holder commits.
  async function resubscribeRace(kind: 'unsubscribed' | 'pending') {
    const orgId = await newOrg();
    const email = `${randomBytes(6).toString('hex')}@example.test`;
    const id = await insertSubscriber(
      orgId,
      kind,
      kind === 'unsubscribed'
        ? { updated: retentionAge('-') }
        : { expires: graceAge('-') },
      email,
    );
    const delivery =
      kind === 'unsubscribed'
        ? await insertDelivery(orgId, id, 'sent', retentionAge('+'))
        : undefined;

    const repository = subscriberRepository();
    const holder = await holdTransaction(orgId, async (raw) => {
      await repository.requestConfirmation(
        { sql: raw as never, orgId },
        { email, tokenHash: 'x', ttlHours: 24, resendSeconds: 0 },
      );
    });
    const pruning = prune(orgId);
    try {
      await waitUntilBlockedBy(holder.pid, 'the prune');
    } finally {
      await holder.commit();
    }
    assert.deepEqual(await pruning, none);
    assert.deepEqual(await subscriberIds(orgId), [id]);
    assert.equal(await subscriberStatus(orgId, id), 'pending');
    assert.deepEqual(
      await deliveryIds(orgId),
      delivery === undefined ? [] : [delivery],
    );
  }

  it('survives a resubscribe that holds the row (unsubscribed)', () =>
    resubscribeRace('unsubscribed'));

  it('survives a resubscribe that holds the row (pending)', () =>
    resubscribeRace('pending'));

  it('prunes only the organization it is given', async () => {
    const first = await newOrg();
    const second = await newOrg();
    for (const orgId of [first, second]) {
      const sub = await insertSubscriber(orgId, 'unsubscribed', {
        updated: retentionAge('-'),
      });
      await insertDelivery(orgId, sub, 'sent', retentionAge('-'));
      await insertSubscriber(orgId, 'pending', { expires: graceAge('-') });
    }
    await prune(first);
    assert.deepEqual(await subscriberIds(first), []);
    assert.equal((await subscriberIds(second)).length, 2);
    assert.equal((await deliveryIds(second)).length, 1);
  });

  it('logs one line for the whole pass, holding the totals', async () => {
    const orgIds = [await newOrg(), await newOrg()];
    for (const orgId of orgIds) {
      const confirmed = await insertSubscriber(orgId, 'confirmed', {});
      await insertDelivery(orgId, confirmed, 'sent', retentionAge('-'));
      await insertSubscriber(orgId, 'unsubscribed', {
        updated: retentionAge('-'),
      });
      await insertSubscriber(orgId, 'pending', { expires: graceAge('-') });
    }
    infos.length = 0;
    errors.length = 0;
    await runNotificationPass(app, logger, { orgIds });
    for (const orgId of orgIds) {
      assert.deepEqual(await deliveryIds(orgId), []);
      assert.equal((await subscriberIds(orgId)).length, 1);
    }
    const lines = infos.filter(
      (entry) => entry.msg === 'notification records pruned',
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].obj.deliveries, 2);
    assert.equal(lines[0].obj.unsubscribed, 2);
    assert.equal(lines[0].obj.neverConfirmed, 2);
    assert.deepEqual(errors, []);
  });

  it('skips the prune once the signal aborts', async () => {
    const orgId = await newOrg();
    const id = await insertSubscriber(orgId, 'unsubscribed', {
      updated: retentionAge('-'),
    });
    const controller = new AbortController();
    controller.abort();
    infos.length = 0;
    await runNotificationPass(app, logger, {
      orgIds: [orgId],
      signal: controller.signal,
    });
    assert.deepEqual(await subscriberIds(orgId), [id]);
    assert.equal(
      infos.filter((entry) => entry.msg === 'notification records pruned')
        .length,
      0,
    );
  });

  it('a prune failure counts toward every organization failed', async () => {
    const orgId = await newOrg();
    const repository = app.diContainer.resolve(
      'subscriberRepository' as never,
    ) as { pruneNeverConfirmed: (...a: unknown[]) => Promise<number> };
    const original = repository.pruneNeverConfirmed;
    repository.pruneNeverConfirmed = async () => {
      throw new Error('prune stub failure');
    };
    errors.length = 0;
    errorMessages.length = 0;
    try {
      await assert.rejects(
        runNotificationPass(app, logger, { orgIds: [orgId] }),
        (error: Error) => {
          assert.equal(error.message, 'every organization failed (1)');
          return true;
        },
      );
    } finally {
      repository.pruneNeverConfirmed = original;
    }
    assert.ok(
      errors.some((entry) => (entry as { orgId?: string }).orgId === orgId),
    );
    assert.ok(
      errorMessages.includes('notification prune failed for organization'),
    );
    errors.length = 0;
  });
});
