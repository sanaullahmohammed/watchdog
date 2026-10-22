import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { queueEmailNotificationCommand } from '@/modules/notification/commands/queue-email-notifications/queue-email-notifications.handler';
import {
  type SendQueuedEmailCommandResult,
  sendQueuedEmailCommand,
} from '@/modules/notification/commands/send-queued-email/send-queued-email.handler';
import type {
  EmailMessage,
  EmailSender,
  SendResult,
} from '@/modules/notification/domain/email-sender.port';
import { formatUtc } from '@/modules/notification/domain/notification-email';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  notificationEmailFailedEvent,
  notificationEmailSentEvent,
} from '@/shared/events/notification.events';
import { capturing } from '@/shared/testing/events';
import {
  declareIncident,
  scheduleMaintenance,
} from '@/shared/testing/fixtures';
import { messagesTo, uniqueRecipient } from '@/shared/testing/mailpit';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';
import { runNotificationPass } from '@/worker';

/**
 * Story 6.7: send owed emails, with retries.
 *
 * Each test has an organization of its own and runs the pass, or the
 * per-organization commands, scoped to it. Delivery is proved against Mailpit
 * with a unique recipient; failures replace `send` on the resolved sender
 * singleton. `next_attempt_at` is moved back with SQL rather than waited for.
 *
 * Sabotage this suite must catch (spec 6.7, AC 5), each by the test that
 * fails under it:
 * - removing `skip locked`: "skips a row another pass holds instead of waiting
 *   for it" (the overlap test below still passes, because Postgres re-checks
 *   the quals after a wait, so only the blocking differs);
 * - removing the `attempts` guard on the record: "lets a stale record change
 *   nothing and announce nothing";
 * - removing the drop of a deleted window: "drops a delivery about a deleted
 *   window".
 */

const tag = `snd-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];
let counter = 0;

type Logged = { level: string; obj: unknown; msg?: string };
let logged: Logged[] = [];
const logger = {
  info(obj: unknown, msg?: string) {
    logged.push({ level: 'info', obj, msg });
  },
  warn(obj: unknown, msg?: string) {
    logged.push({ level: 'warn', obj, msg });
  },
  error(obj: unknown, msg?: string) {
    logged.push({ level: 'error', obj, msg });
  },
} as unknown as FastifyBaseLogger;

type Org = { cookie: string; orgId: string; slug: string };

async function newOrg(): Promise<Org> {
  counter += 1;
  const slug = `${tag}-${counter}`;
  const { cookie, orgId, userId } = await signUpWithOrg(app, slug);
  created.push({ orgId, userId });
  return { cookie, orgId, slug };
}

/** A confirmed subscriber at `address`, a day before any change. */
const subscribe = (orgId: string, address: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<{ id: string }[]>`
      insert into subscribers (org_id, email, status, confirmed_at)
      values (${orgId}, ${address}, 'confirmed', now() - interval '1 day')
      returning id
    `;
    return row.id;
  });

const queue = (orgId: string) =>
  app.commandBus.execute(queueEmailNotificationCommand({ orgId }));

const send = (orgId: string) =>
  app.commandBus.execute<SendQueuedEmailCommandResult>(
    sendQueuedEmailCommand({ orgId }),
  );

/** Sends until nothing is left to claim, returning each outcome. */
async function sendAll(orgId: string) {
  const outcomes: string[] = [];
  for (;;) {
    const { outcome } = await send(orgId);
    if (outcome === 'none') return outcomes;
    outcomes.push(outcome);
  }
}

type Delivery = {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  wait: number;
};

/** `wait` is seconds from now to `next_attempt_at`. */
const deliveries = (orgId: string) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<Delivery[]>`
      select id, status, attempts, last_error, sent_at,
             extract(epoch from next_attempt_at - now())::float8 as wait
      from notification_deliveries
      order by created_at, id
    `,
  );

const makeDue = (orgId: string) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx`
      update notification_deliveries
      set next_attempt_at = now() - interval '1 second'
      where status = 'pending'
    `,
  );

const setDelivery = (orgId: string, set: 'attempts' | 'due', value: number) =>
  withTenantTransaction(orgId, ({ sql: tx }) =>
    set === 'attempts'
      ? tx`update notification_deliveries set attempts = ${value}, next_attempt_at = now() - interval '1 minute'`
      : tx`update notification_deliveries set next_attempt_at = now() + make_interval(secs => ${value})`,
  );

/** One owed delivery (a scheduled window) for a fresh subscriber. */
async function oneOwed() {
  const org = await newOrg();
  const address = uniqueRecipient('snd');
  const subscriberId = await subscribe(org.orgId, address);
  const windowId = await scheduleMaintenance(app, org.cookie);
  await queue(org.orgId);
  const [row] = await deliveries(org.orgId);
  assert.ok(row, 'a delivery was queued');
  return { org, address, subscriberId, windowId, deliveryId: row.id };
}

const sender = () => app.diContainer.resolve('emailSender');
let realSend: EmailSender['send'];
const restore = () => {
  sender().send = realSend;
};
const stubSend = (fn: (message: EmailMessage) => Promise<SendResult>) => {
  sender().send = fn;
};

describe('story 6.7: send owed emails, with retries', () => {
  before(async () => {
    app = await buildApp();
    await app.ready();
    realSend = sender().send;
  });

  afterEach(() => {
    restore();
    logged = [];
  });

  after(async () => {
    for (const { orgId, userId } of created) {
      await sql`delete from "organization" where "id" = ${orgId}`;
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('sends one email through Mailpit, records it, and announces it', async () => {
    const { org, address, subscriberId, deliveryId } = await oneOwed();

    const sent = await capturing(app, notificationEmailSentEvent.type, () =>
      send(org.orgId),
    );
    assert.deepEqual(sent.result, { outcome: 'sent' });

    const [row] = await deliveries(org.orgId);
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1);
    assert.ok(row.sent_at);

    const [message, ...rest] = await messagesTo(address, { atLeast: 1 });
    assert.equal(rest.length, 0);
    assert.match(message.Subject, /^\[.*\] Maintenance scheduled:/);
    assert.ok(message.Headers['List-Unsubscribe']?.[0]?.startsWith('<http'));
    assert.equal(
      message.Headers['List-Unsubscribe-Post']?.[0],
      'List-Unsubscribe=One-Click',
    );
    assert.equal(message.HTML, '');
    assert.ok(message.Text.includes(`/status/${org.slug}`));
    assert.ok(message.Text.includes(`subscriber=${subscriberId}`));

    assert.equal(sent.captured.length, 1);
    assert.equal(
      (sent.captured[0] as { payload: { deliveryId: string } }).payload
        .deliveryId,
      deliveryId,
    );
  });

  it('words each incident entry with its own status, message and posted time', async () => {
    const org = await newOrg();
    const address = uniqueRecipient('snd');
    await subscribe(org.orgId, address);
    const incidentId = await declareIncident(app, org.cookie, {
      title: `${tag} outage`,
      message: `${tag} first message`,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/transition`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
      payload: { status: 'resolved', message: `${tag} second message` },
    });
    assert.equal(response.statusCode, 200, response.body);
    await queue(org.orgId);
    await sendAll(org.orgId);

    const entries = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ status: string; message: string; at: Date }[]>`
        select status, message, created_at as at
        from incident_updates
        where incident_id = ${incidentId}
        order by sequence
      `,
    );
    assert.deepEqual(
      entries.map((e) => e.status),
      ['investigating', 'resolved'],
    );
    const messages = await messagesTo(address, { atLeast: 2 });
    assert.equal(messages.length, 2);
    for (const entry of entries) {
      const text = messages.find((m) => m.Text.includes(entry.message))?.Text;
      assert.ok(text, `an email carries "${entry.message}"`);
      const status = entry.status === 'resolved' ? 'Resolved' : 'Investigating';
      assert.ok(text.includes(`Status: ${status}`), text);
      assert.ok(text.includes(`Posted ${formatUtc(entry.at)}.`), text);
      const other = entries.find((e) => e !== entry);
      assert.ok(other && !text.includes(other.message), text);
    }
    assert.ok(
      messages.every(
        (m) =>
          m.Subject.startsWith(`[`) && m.Subject.includes(`${tag} outage: `),
      ),
    );
  });

  it('retries a transient failure on the doubling schedule, then abandons', async () => {
    const { org } = await oneOwed();
    stubSend(async () => ({ outcome: 'transient', diagnostic: 'ETIMEDOUT' }));
    const failed = await capturing(
      app,
      notificationEmailFailedEvent.type,
      async () => {
        const waits: number[] = [];
        for (let attempt = 1; attempt <= 7; attempt += 1) {
          assert.deepEqual(await send(org.orgId), {
            outcome: 'retrying',
            diagnostic: 'ETIMEDOUT',
          });
          const [row] = await deliveries(org.orgId);
          assert.equal(row.status, 'pending');
          assert.equal(row.attempts, attempt);
          assert.equal(row.last_error, 'ETIMEDOUT');
          waits.push(row.wait);
          await makeDue(org.orgId);
        }
        return waits;
      },
    );
    const expected = [60, 120, 240, 480, 960, 1920, 3600];
    failed.result.forEach((wait, i) => {
      assert.ok(
        wait <= expected[i] + 2 && wait > expected[i] - 32,
        `wait ${i + 1}: ${wait}`,
      );
    });
    assert.equal(failed.captured.length, 0);

    const last = await capturing(app, notificationEmailFailedEvent.type, () =>
      send(org.orgId),
    );
    assert.equal(last.result.outcome, 'abandoned');
    const [row] = await deliveries(org.orgId);
    assert.equal(row.status, 'abandoned');
    assert.equal(row.attempts, 8);
    assert.equal(row.last_error, 'ETIMEDOUT');
    assert.equal(last.captured.length, 1);
    assert.deepEqual(await send(org.orgId), { outcome: 'none' });
  });

  it('fails a permanent refusal at once', async () => {
    const { org, address } = await oneOwed();
    stubSend(async () => ({ outcome: 'permanent', diagnostic: 'SMTP 550' }));
    const failed = await capturing(app, notificationEmailFailedEvent.type, () =>
      send(org.orgId),
    );
    assert.equal(failed.result.outcome, 'failed');
    const [row] = await deliveries(org.orgId);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'SMTP 550');
    assert.equal(failed.captured.length, 1);
    assert.equal((await messagesTo(address)).length, 0);
  });

  it('sends each row exactly once when two dispatches overlap', async () => {
    const org = await newOrg();
    await subscribe(org.orgId, uniqueRecipient('snd'));
    for (let i = 0; i < 4; i += 1) await scheduleMaintenance(app, org.cookie);
    await queue(org.orgId);
    const sends: string[] = [];
    stubSend(async (message) => {
      sends.push(message.subject);
      await sleep(40);
      return { outcome: 'accepted' };
    });

    await Promise.all([sendAll(org.orgId), sendAll(org.orgId)]);

    assert.equal(sends.length, 4);
    assert.equal(new Set(sends).size, 4);
    const rows = await deliveries(org.orgId);
    assert.deepEqual(
      rows.map((r) => `${r.status}:${r.attempts}`),
      Array(4).fill('sent:1'),
    );
  });

  it('skips a row another pass holds instead of waiting for it', async () => {
    const org = await newOrg();
    await subscribe(org.orgId, uniqueRecipient('snd'));
    for (let i = 0; i < 2; i += 1) await scheduleMaintenance(app, org.cookie);
    await queue(org.orgId);
    stubSend(async () => ({ outcome: 'accepted' }));

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another pass, mid-claim: holds the oldest due row.
    const holder = withTenantTransaction(org.orgId, async ({ sql: tx }) => {
      await tx`
        select id from notification_deliveries
        where status = 'pending'
        order by next_attempt_at, id
        limit 1
        for update
      `;
      locked();
      await released;
    });
    await lockHeld;
    try {
      const result = await Promise.race([
        send(org.orgId),
        sleep(3_000).then(() => 'blocked'),
      ]);
      assert.deepEqual(result, { outcome: 'sent' });
    } finally {
      release();
      await holder;
    }
    const rows = await deliveries(org.orgId);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['pending', 'sent']);
  });

  it('claims a leased row again once its lease is past', async () => {
    const { org, address } = await oneOwed();
    await setDelivery(org.orgId, 'attempts', 1);
    assert.equal((await send(org.orgId)).outcome, 'sent');
    const [row] = await deliveries(org.orgId);
    assert.equal(row.attempts, 2);
    assert.equal(row.status, 'sent');
    assert.equal((await messagesTo(address, { atLeast: 1 })).length, 1);
  });

  it('abandons at claim, sending nothing, a row already at the limit', async () => {
    const { org, address } = await oneOwed();
    await setDelivery(org.orgId, 'attempts', 8);
    const failed = await capturing(app, notificationEmailFailedEvent.type, () =>
      send(org.orgId),
    );
    assert.deepEqual(failed.result, {
      outcome: 'abandoned',
      diagnostic: 'EUNRECORDED',
    });
    const [row] = await deliveries(org.orgId);
    assert.equal(row.status, 'abandoned');
    assert.equal(row.attempts, 8);
    // Marked, so it differs from a run of transient failures.
    assert.equal(row.last_error, 'EUNRECORDED');
    assert.equal(failed.captured.length, 1);
    assert.equal((await messagesTo(address)).length, 0);
  });

  it('lets a stale record change nothing and announce nothing', async () => {
    const { org } = await oneOwed();
    let calls = 0;
    stubSend(async () => {
      calls += 1;
      if (calls > 1) return { outcome: 'transient', diagnostic: 'SECOND' };
      // The first send outlives its lease: another pass claims the row and
      // gets a transient answer before this one answers.
      await makeDue(org.orgId);
      assert.equal((await send(org.orgId)).outcome, 'retrying');
      return { outcome: 'permanent', diagnostic: 'SMTP 550' };
    });
    const failed = await capturing(app, notificationEmailFailedEvent.type, () =>
      send(org.orgId),
    );
    assert.deepEqual(failed.result, { outcome: 'stale' });
    const [row] = await deliveries(org.orgId);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 2);
    assert.equal(row.last_error, 'SECOND');
    assert.equal(failed.captured.length, 0);
  });

  it('drops a delivery about a deleted window', async () => {
    const { org, address, windowId } = await oneOwed();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/maintenance/${windowId}`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    });
    assert.ok(response.statusCode < 300, response.body);
    assert.deepEqual(await send(org.orgId), { outcome: 'dropped' });
    assert.equal((await deliveries(org.orgId)).length, 0);
    assert.equal((await messagesTo(address)).length, 0);
  });

  it('drops a delivery whose subscriber is no longer confirmed', async () => {
    const { org, address, subscriberId } = await oneOwed();
    await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) =>
        tx`update subscribers set status = 'pending' where id = ${subscriberId}`,
    );
    assert.deepEqual(await send(org.orgId), { outcome: 'dropped' });
    assert.equal((await deliveries(org.orgId)).length, 0);
    assert.equal((await messagesTo(address)).length, 0);
  });

  it('words a window completed without starting as ended without starting', async () => {
    const { org, address, windowId } = await oneOwed();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maintenance/${windowId}/complete`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    });
    assert.ok(response.statusCode < 300, response.body);
    await queue(org.orgId);
    await sendAll(org.orgId);
    const messages = await messagesTo(address, { atLeast: 2 });
    const subjects = messages.map((m) => m.Subject);
    assert.ok(
      subjects.some((s) => s.includes('Maintenance ended without starting:')),
      subjects.join('|'),
    );
    assert.ok(!subjects.some((s) => s.includes('Maintenance completed:')));
  });

  it('does not claim a row that is not due', async () => {
    const { org, address } = await oneOwed();
    await setDelivery(org.orgId, 'due', 3600);
    assert.deepEqual(await send(org.orgId), { outcome: 'none' });
    const [row] = await deliveries(org.orgId);
    assert.equal(row.attempts, 0);
    assert.equal((await messagesTo(address)).length, 0);
  });

  it('holds no lock across the send, and has leased the row before it', async () => {
    const { org, deliveryId } = await oneOwed();
    let seen: { attempts: number; wait: number } | undefined;
    stubSend(async () => {
      // `nowait` throws if any transaction still holds the row.
      seen = await withTenantTransaction(org.orgId, async ({ sql: tx }) => {
        const [row] = await tx<{ attempts: number; wait: number }[]>`
          select attempts,
                 extract(epoch from next_attempt_at - now())::float8 as wait
          from notification_deliveries
          where id = ${deliveryId}
          for update nowait
        `;
        return row;
      });
      return { outcome: 'accepted' };
    });
    await send(org.orgId);
    assert.ok(seen);
    assert.equal(seen.attempts, 1);
    assert.ok(seen.wait > 28 && seen.wait <= 62, `lease ${seen.wait}`);
  });

  it('claims nothing more once aborted, and records the send in flight first', async () => {
    const org = await newOrg();
    await subscribe(org.orgId, uniqueRecipient('snd'));
    for (let i = 0; i < 3; i += 1) await scheduleMaintenance(app, org.cookie);
    const controller = new AbortController();
    let calls = 0;
    stubSend(async () => {
      calls += 1;
      controller.abort();
      await sleep(150);
      return { outcome: 'accepted' };
    });

    await runNotificationPass(app, logger, {
      orgIds: [org.orgId],
      signal: controller.signal,
    });

    assert.equal(calls, 1);
    const rows = await deliveries(org.orgId);
    assert.deepEqual(rows.map((r) => `${r.status}:${r.attempts}`).sort(), [
      'pending:0',
      'pending:0',
      'sent:1',
    ]);
  });

  it('leaves the rest pending and unleased when the budget runs out', async () => {
    const org = await newOrg();
    await subscribe(org.orgId, uniqueRecipient('snd'));
    for (let i = 0; i < 3; i += 1) await scheduleMaintenance(app, org.cookie);
    stubSend(async () => ({ outcome: 'accepted' }));

    await runNotificationPass(app, logger, {
      orgIds: [org.orgId],
      dispatchBudgetMs: 0,
    });

    const rows = await deliveries(org.orgId);
    assert.deepEqual(rows.map((r) => `${r.status}:${r.attempts}`).sort(), [
      'pending:0',
      'pending:0',
      'sent:1',
    ]);
    for (const row of rows.filter((r) => r.status === 'pending')) {
      assert.ok(row.wait <= 2, 'still due, not leased');
    }
  });

  it('summarises transient failures in one warn line, with no address anywhere', async () => {
    const org = await newOrg();
    const address = uniqueRecipient('snd');
    await subscribe(org.orgId, address);
    for (let i = 0; i < 3; i += 1) await scheduleMaintenance(app, org.cookie);
    stubSend(async () => ({
      outcome: 'transient',
      diagnostic: 'ECONNREFUSED',
    }));

    await runNotificationPass(app, logger, { orgIds: [org.orgId] });

    const warns = logged.filter((entry) => entry.level === 'warn');
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0].obj, { retrying: { ECONNREFUSED: 3 } });
    assert.ok(!JSON.stringify(logged).includes(address));
    for (const row of await deliveries(org.orgId)) {
      assert.ok(!(row.last_error ?? '').includes(address));
      assert.equal(row.last_error, 'ECONNREFUSED');
    }
  });

  it('sends one row for each organization on two consecutive passes with no budget', async () => {
    const orgs = [await newOrg(), await newOrg()];
    for (const org of orgs) {
      await subscribe(org.orgId, uniqueRecipient('snd'));
      for (let i = 0; i < 3; i += 1) await scheduleMaintenance(app, org.cookie);
    }
    stubSend(async () => ({ outcome: 'accepted' }));
    const orgIds = orgs.map((org) => org.orgId);

    await runNotificationPass(app, logger, { orgIds, dispatchBudgetMs: 0 });
    await runNotificationPass(app, logger, { orgIds, dispatchBudgetMs: 0 });

    for (const org of orgs) {
      const rows = await deliveries(org.orgId);
      assert.deepEqual(rows.map((r) => r.status).sort(), [
        'pending',
        'pending',
        'sent',
      ]);
    }
  });

  it('leaves a later organization pending and unleased when the budget is spent mid-round', async () => {
    const orgs = [await newOrg(), await newOrg()];
    for (const org of orgs) {
      await subscribe(org.orgId, uniqueRecipient('snd'));
      await scheduleMaintenance(app, org.cookie);
    }
    stubSend(async () => {
      await sleep(80);
      return { outcome: 'accepted' };
    });

    await runNotificationPass(app, logger, {
      orgIds: orgs.map((org) => org.orgId),
      dispatchBudgetMs: 30,
    });

    const rows = (
      await Promise.all(orgs.map((org) => deliveries(org.orgId)))
    ).flat();
    assert.deepEqual(rows.map((r) => `${r.status}:${r.attempts}`).sort(), [
      'pending:0',
      'sent:1',
    ]);
    const waiting = rows.find((r) => r.status === 'pending');
    assert.ok(waiting && waiting.wait <= 2, 'still due, not leased');
  });

  it('still sends the other organization when one organization send throws', async () => {
    const bad = await newOrg();
    const good = await newOrg();
    const badAddress = uniqueRecipient('snd');
    const goodAddress = uniqueRecipient('snd');
    await subscribe(bad.orgId, badAddress);
    await subscribe(good.orgId, goodAddress);
    await scheduleMaintenance(app, bad.cookie);
    await scheduleMaintenance(app, good.cookie);
    stubSend(async (message) => {
      if (message.to === badAddress) throw new Error('boom');
      return { outcome: 'accepted' };
    });

    await runNotificationPass(app, logger, {
      orgIds: [bad.orgId, good.orgId],
    });

    assert.equal(logged.filter((entry) => entry.level === 'error').length, 1);
    assert.deepEqual(
      (await deliveries(good.orgId)).map((r) => r.status),
      ['sent'],
    );

    // With only the throwing organization, every organization failed.
    await makeDue(bad.orgId);
    await assert.rejects(
      runNotificationPass(app, logger, { orgIds: [bad.orgId] }),
      /every organization failed \(1\)/,
    );
  });

  it('puts an emailed unsubscribe link to work by GET and by one-click POST', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const { org, address, subscriberId } = await oneOwed();
      assert.equal((await send(org.orgId)).outcome, 'sent');
      const [message] = await messagesTo(address, { atLeast: 1 });
      const header = message.Headers['List-Unsubscribe']?.[0] ?? '';
      const fromBody = message.Text.match(
        /https?:\/\/\S+\/subscribers\/unsubscribe\?\S+/,
      );
      const link =
        method === 'GET' ? fromBody?.[0] : header.replace(/^<|>$/g, '');
      assert.ok(link, `a ${method} link`);
      const { pathname, search } = new URL(link);
      assert.ok(pathname.startsWith(`/status/${org.slug}/`), pathname);

      const response = await app.inject({
        method,
        url: `${pathname}${search}`,
        remoteAddress: '10.9.9.9',
      });
      assert.equal(response.statusCode, 200, response.body);
      const [subscriber] = await withTenantTransaction(
        org.orgId,
        ({ sql: tx }) => tx<{ status: string }[]>`
          select status from subscribers where id = ${subscriberId}
        `,
      );
      assert.equal(subscriber.status, 'unsubscribed');
    }
  });

  it('keeps an organization in the rounds after a stale record', async () => {
    const org = await newOrg();
    await subscribe(org.orgId, uniqueRecipient('snd'));
    for (let i = 0; i < 2; i += 1) await scheduleMaintenance(app, org.cookie);
    let calls = 0;
    stubSend(async () => {
      calls += 1;
      if (calls === 1) {
        // The first send outlives its lease and another claim retries it.
        await withTenantTransaction(
          org.orgId,
          ({ sql: tx }) => tx`
            update notification_deliveries
            set next_attempt_at = now() - interval '1 second'
            where attempts > 0
          `,
        );
        assert.equal((await send(org.orgId)).outcome, 'retrying');
        return { outcome: 'permanent', diagnostic: 'SMTP 550' };
      }
      if (calls === 2) return { outcome: 'transient', diagnostic: 'LATE' };
      return { outcome: 'accepted' };
    });

    await runNotificationPass(app, logger, { orgIds: [org.orgId] });

    const rows = await deliveries(org.orgId);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['pending', 'sent']);
  });

  it('summarises permanent refusals under failed', async () => {
    const org = await newOrg();
    await subscribe(org.orgId, uniqueRecipient('snd'));
    await scheduleMaintenance(app, org.cookie);
    stubSend(async () => ({ outcome: 'permanent', diagnostic: 'SMTP 550' }));

    await runNotificationPass(app, logger, { orgIds: [org.orgId] });

    const warns = logged.filter((entry) => entry.level === 'warn');
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0].obj, { failed: { 'SMTP 550': 1 } });
  });

  it('summarises rows that reach the attempt limit under abandoned', async () => {
    const sent = await newOrg();
    await subscribe(sent.orgId, uniqueRecipient('snd'));
    await scheduleMaintenance(app, sent.cookie);
    const unrecorded = await newOrg();
    await subscribe(unrecorded.orgId, uniqueRecipient('snd'));
    await scheduleMaintenance(app, unrecorded.cookie);
    stubSend(async () => ({ outcome: 'transient', diagnostic: 'ETIMEDOUT' }));
    // One reaches the limit by a failed send, one at claim with no send.
    await queue(sent.orgId);
    await queue(unrecorded.orgId);
    await setDelivery(sent.orgId, 'attempts', 7);
    await setDelivery(unrecorded.orgId, 'attempts', 8);

    await runNotificationPass(app, logger, {
      orgIds: [sent.orgId, unrecorded.orgId],
    });

    const warns = logged.filter((entry) => entry.level === 'warn');
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0].obj, {
      abandoned: { ETIMEDOUT: 1, EUNRECORDED: 1 },
    });
  });

  it('alternates between organizations within one pass', async () => {
    const orgs = [await newOrg(), await newOrg()];
    const owner = new Map<string, string>();
    for (const org of orgs) {
      const address = uniqueRecipient('snd');
      owner.set(address, org.orgId);
      await subscribe(org.orgId, address);
      for (let i = 0; i < 3; i += 1) await scheduleMaintenance(app, org.cookie);
    }
    const order: string[] = [];
    stubSend(async (message) => {
      order.push(owner.get(message.to) ?? '?');
      return { outcome: 'accepted' };
    });

    await runNotificationPass(app, logger, {
      orgIds: orgs.map((org) => org.orgId),
      dispatchBudgetMs: 600_000,
    });

    assert.equal(order.length, 6);
    for (let i = 1; i < order.length; i += 1) {
      assert.notEqual(order[i], order[i - 1], order.join(','));
    }
  });
});
