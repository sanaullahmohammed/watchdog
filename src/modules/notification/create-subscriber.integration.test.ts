import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { createSubscriberCommand } from '@/modules/notification/commands/create-subscriber/create-subscriber.handler';
import type { EmailSender } from '@/modules/notification/domain/email-sender.port';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { subscriberCreatedEvent } from '@/shared/events/subscriber.events';
import { ArgumentInvalidException } from '@/shared/exceptions';
import { capturing } from '@/shared/testing/events';
import { captureLogs } from '@/shared/testing/logs';
import { messagesTo, uniqueRecipient } from '@/shared/testing/mailpit';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 6.3: subscribe to an organization's status page. The sender is the
 * real one, reaching Mailpit; a send that must fail is stubbed on the
 * container's singleton and restored in `finally`.
 */

const tag = `sub-${randomBytes(4).toString('hex')}`;
const otherTag = `${tag}-b`;

const ACCEPTED = {
  message:
    'If this address is not already subscribed, a confirmation email is on its way.',
};

type Row = {
  id: string;
  email: string;
  status: string;
  confirmation_token_hash: string | null;
  confirmation_expires_at: Date | null;
  confirmation_sent_at: Date | null;
  confirmed_at: Date | null;
};

let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;
let orgId = '';
let userId = '';
let otherOrgId = '';
let otherUserId = '';
let octet = 0;

/** Each request comes from its own address, so the per-IP limit never trips. */
const subscribe = (
  email: unknown,
  slug = tag,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
) => {
  octet += 1;
  return target.inject({
    method: 'POST',
    url: `/status/${slug}/subscribers`,
    headers,
    payload: { email },
    remoteAddress: `10.${(octet >> 16) & 255}.${(octet >> 8) & 255}.${octet & 255}`,
  });
};

const rowFor = async (email: string, org = orgId) =>
  withTenantTransaction(org, async ({ sql: tx }) => {
    const rows = await tx<Row[]>`
      select * from subscribers where lower(email) = ${email.toLowerCase()}
    `;
    return rows[0];
  });

/** Writes the state a case starts from, with the clock in SQL. */
const seed = (
  email: string,
  status: string,
  sentSecondsAgo: number | null,
  hash = 'seeded-hash',
) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx`
      insert into subscribers (
        org_id, email, status, confirmation_token_hash, confirmation_sent_at,
        confirmed_at
      )
      values (
        ${orgId}, ${email}, ${status}, ${hash},
        ${sentSecondsAgo === null ? null : tx`now() - make_interval(secs => ${sentSecondsAgo})`},
        ${status === 'confirmed' ? tx`now()` : null}
      )
    `,
  );

const mailTo = async (email: string, atLeast = 0) => {
  await app.diContainer.cradle.confirmationSendsService.drain();
  return messagesTo(email, { atLeast, timeoutMs: atLeast ? 2_000 : 300 });
};

const tokenIn = (text: string) => {
  const match = text.match(/token=([\w-]+)/);
  assert.ok(match, 'the email carries a link with a token');
  return match[1];
};

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('Story 6.3: subscribe to an organization s status page', () => {
  before(async () => {
    logs = captureLogs();
    app = await buildApp({ logger: { level: 'info', stream: logs.stream } });
    await app.ready();
    ({ orgId, userId } = await signUpWithOrg(app, tag));
    ({ orgId: otherOrgId, userId: otherUserId } = await signUpWithOrg(
      app,
      otherTag,
    ));
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgId}, ${otherOrgId})`;
    await sql`delete from "user" where "id" in (${userId}, ${otherUserId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('stores a new address trimmed and lowercased, and emails the link', async () => {
    const email = uniqueRecipient('new');
    const sloppy = `  ${email.toUpperCase()} `;

    const { result, captured } = await capturing(
      app,
      subscriberCreatedEvent.type,
      () => subscribe(sloppy),
    );
    assert.equal(result.statusCode, 202, result.body);
    assert.deepEqual(JSON.parse(result.body), ACCEPTED);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['access-control-allow-origin'], '*');

    const row = await rowFor(email);
    assert.equal(row.email, email);
    assert.equal(row.status, 'pending');
    assert.ok(row.confirmation_token_hash);
    assert.ok(row.confirmation_expires_at && row.confirmation_sent_at);
    const ttlMs =
      row.confirmation_expires_at.getTime() -
      row.confirmation_sent_at.getTime();
    assert.equal(ttlMs, env.subscribe.confirmationTtlHours * 3_600_000);

    const messages = await mailTo(email, 1);
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(
      message.Subject,
      'Confirm your subscription to Display Name status updates'.replace(
        'Display Name',
        `${tag} Display Name`,
      ),
    );
    const text = message.Text.replace(/\r\n/g, '\n');
    assert.ok(
      text.includes(
        `${env.publicBaseUrl}/status/${tag}/subscribers/confirm?token=`,
      ),
    );
    assert.ok(text.includes(`${env.subscribe.confirmationTtlHours} hours`));
    assert.ok(
      text.includes(
        'If you did not ask for this, ignore this email; nothing more will be sent.',
      ),
    );
    assert.equal(message.Headers['List-Unsubscribe'], undefined);
    assert.equal(message.HTML, '');
    assert.equal(row.confirmation_token_hash, sha256(tokenIn(text)));

    assert.equal(captured.length, 1);
    const event = captured[0] as { payload: Record<string, unknown> };
    assert.deepEqual(event.payload, { orgId, subscriberId: row.id });
  });

  it('replaces the token of an unthrottled pending address and sends one more email, with no event', async () => {
    const email = uniqueRecipient('pending');
    await seed(email, 'pending', env.subscribe.confirmationResendSeconds + 60);

    const { result, captured } = await capturing(
      app,
      subscriberCreatedEvent.type,
      () => subscribe(email),
    );
    assert.equal(result.statusCode, 202);
    assert.deepEqual(JSON.parse(result.body), ACCEPTED);

    const row = await rowFor(email);
    assert.notEqual(row.confirmation_token_hash, 'seeded-hash');
    const messages = await mailTo(email, 1);
    assert.equal(messages.length, 1);
    assert.equal(
      row.confirmation_token_hash,
      sha256(tokenIn(messages[0].Text)),
    );
    // The address is the only one this test subscribed, so its event count is
    // read from the row id rather than the (shared) bus.
    assert.ok(
      !captured.some(
        (e) =>
          (e as { payload: { subscriberId: string } }).payload.subscriberId ===
          row.id,
      ),
    );
  });

  it('returns an unsubscribed address to pending with a new token, and announces it', async () => {
    const email = uniqueRecipient('unsub');
    await seed(
      email,
      'unsubscribed',
      env.subscribe.confirmationResendSeconds + 60,
    );

    const { result, captured } = await capturing(
      app,
      subscriberCreatedEvent.type,
      () => subscribe(email),
    );
    assert.equal(result.statusCode, 202);

    const row = await rowFor(email);
    assert.equal(row.status, 'pending');
    assert.notEqual(row.confirmation_token_hash, 'seeded-hash');
    assert.equal((await mailTo(email, 1)).length, 1);
    assert.ok(
      captured.some(
        (e) =>
          (e as { payload: { subscriberId: string } }).payload.subscriberId ===
          row.id,
      ),
    );
  });

  it('changes nothing and sends nothing for a confirmed address', async () => {
    const email = uniqueRecipient('confirmed');
    await seed(
      email,
      'confirmed',
      env.subscribe.confirmationResendSeconds + 60,
    );
    const before = await rowFor(email);

    const { result, captured } = await capturing(
      app,
      subscriberCreatedEvent.type,
      () => subscribe(email),
    );
    assert.equal(result.statusCode, 202);

    assert.deepEqual(await rowFor(email), before);
    assert.equal((await mailTo(email)).length, 0);
    assert.ok(
      !captured.some(
        (e) =>
          (e as { payload: { subscriberId: string } }).payload.subscriberId ===
          before.id,
      ),
    );
  });

  it('changes nothing and sends nothing inside the resend window, in any state', async () => {
    for (const status of ['pending', 'unsubscribed', 'confirmed']) {
      const email = uniqueRecipient(`throttled-${status}`);
      await seed(email, status, 1);
      const before = await rowFor(email);

      const { result, captured } = await capturing(
        app,
        subscriberCreatedEvent.type,
        () => subscribe(email),
      );
      assert.equal(result.statusCode, 202, status);

      assert.deepEqual(await rowFor(email), before, status);
      assert.equal((await mailTo(email)).length, 0, status);
      assert.ok(
        !captured.some(
          (e) =>
            (e as { payload: { subscriberId: string } }).payload
              .subscriberId === before.id,
        ),
        status,
      );
    }
  });

  it('answers every state with the same status, headers and body', async () => {
    const fresh = uniqueRecipient('same-new');
    const pending = uniqueRecipient('same-pending');
    const confirmed = uniqueRecipient('same-confirmed');
    const unsubscribed = uniqueRecipient('same-unsub');
    const throttled = uniqueRecipient('same-throttled');
    await seed(pending, 'pending', 100_000);
    await seed(confirmed, 'confirmed', 100_000);
    await seed(unsubscribed, 'unsubscribed', 100_000);
    await seed(throttled, 'pending', 1);

    const answers: {
      statusCode: number;
      headers: Record<string, unknown>;
      body: string;
    }[] = [];
    for (const email of [fresh, pending, confirmed, unsubscribed, throttled]) {
      const { statusCode, headers, body } = await subscribe(email);
      const {
        date: _date,
        'x-request-id': _id,
        'request-id': _rid,
        ...rest
      } = headers;
      answers.push({ statusCode, headers: rest, body });
    }
    for (const answer of answers) {
      assert.deepEqual(answer, answers[0]);
    }
    assert.equal(answers[0].statusCode, 202);
  });

  it('sends one email and keeps one row when the same new address arrives at once', async () => {
    const email = uniqueRecipient('race-new');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => subscribe(email)),
    );
    for (const result of results) {
      assert.equal(result.statusCode, 202, result.body);
      assert.deepEqual(JSON.parse(result.body), ACCEPTED);
    }
    const count = await withTenantTransaction(
      orgId,
      ({ sql: tx }) => tx`
      select count(*)::int as n from subscribers where lower(email) = ${email}
    `,
    );
    assert.equal(count[0].n, 1);
    assert.equal((await mailTo(email, 1)).length, 1);
    // No unique violation, and so no address, reached the logs.
    assert.ok(!logs.lines.some((line) => line.includes(email)));
  });

  it('sends one email when an unthrottled pending address is requested at once', async () => {
    const email = uniqueRecipient('race-pending');
    await seed(email, 'pending', env.subscribe.confirmationResendSeconds + 60);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => subscribe(email)),
    );
    for (const result of results) assert.equal(result.statusCode, 202);
    assert.equal((await mailTo(email, 1)).length, 1);
  });

  it('answers a bad or unknown slug with the uniform miss and the public headers', async () => {
    const email = uniqueRecipient('miss');
    for (const slug of [`${tag}-missing`, 'Not_A_Slug']) {
      const miss = await subscribe(email, slug);
      assert.equal(miss.statusCode, 404, slug);
      assert.equal(miss.headers['access-control-allow-origin'], '*');
      assert.equal(JSON.parse(miss.body).message, 'Status page not found');
    }
    assert.equal((await mailTo(email)).length, 0);
  });

  it('refuses a bad address with a 400 that does not echo it', async () => {
    const long = `${'a'.repeat(250)}@x.test`;
    const bads: unknown[] = [
      'not an address',
      'Ann <ann@x.test>',
      'a@b@c.test',
      long,
      `${'a'.repeat(321)}`,
      '',
      '   ',
      undefined,
      42,
      null,
    ];
    for (const bad of bads) {
      const result = await subscribe(bad);
      assert.equal(result.statusCode, 400, String(bad));
      assert.equal(result.headers['access-control-allow-origin'], '*');
      for (const echoed of ['not an address', 'ann@x.test', 'aaaaaaaaaa']) {
        assert.ok(!result.body.includes(echoed), result.body);
      }
    }
    const missing = await app.inject({
      method: 'POST',
      url: `/status/${tag}/subscribers`,
      payload: {},
      remoteAddress: '10.9.9.9',
    });
    assert.equal(missing.statusCode, 400);
    assert.ok(!logs.lines.some((line) => line.includes('not an address')));
  });

  it('validates the body before the slug is read', async () => {
    const known = await subscribe('nope', tag);
    const unknown = await subscribe('nope', `${tag}-missing`);
    assert.equal(known.statusCode, 400);
    assert.equal(unknown.statusCode, 400);
    assert.equal(
      JSON.parse(known.body).message,
      JSON.parse(unknown.body).message,
    );
  });

  it('refuses the same raw input in the handler as the route does', async () => {
    // A command bypassing REST validation still meets the schema.
    for (const email of ['nope', 42, `${' '.repeat(330)}a@b.test`]) {
      await assert.rejects(
        app.commandBus.execute(
          createSubscriberCommand({ orgSlug: tag, email: email as string }),
        ),
        (error: unknown) =>
          error instanceof ArgumentInvalidException && error.statusCode === 400,
        String(email).slice(0, 10),
      );
    }
  });

  it('keeps a subscriber inside its own organization', async () => {
    const email = uniqueRecipient('isolated');
    assert.equal((await subscribe(email)).statusCode, 202);

    const seenByOther = await rowFor(email, otherOrgId);
    assert.equal(seenByOther, undefined);

    // The same address may subscribe to another organization.
    assert.equal((await subscribe(email, otherTag)).statusCode, 202);
    assert.ok(await rowFor(email, otherOrgId));
    assert.equal((await mailTo(email, 2)).length, 2);
  });

  it('answers a preflight for a JSON body without credentials', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `/status/${tag}/subscribers`,
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal(
      preflight.headers['access-control-allow-methods'],
      'POST, OPTIONS',
    );
    assert.equal(
      preflight.headers['access-control-allow-headers'],
      'content-type',
    );
    assert.equal(
      preflight.headers['access-control-allow-credentials'],
      undefined,
    );
  });

  it('answers 202 and keeps the row throttled when the send fails, logging no address', async () => {
    const sender = app.diContainer.resolve('emailSender') as EmailSender;
    const original = sender.send;
    const ids: string[] = [];
    try {
      for (const outcome of ['transient', 'permanent'] as const) {
        sender.send = async () => ({ outcome, diagnostic: 'SMTP 550' });
        const email = uniqueRecipient(`fail-${outcome}`);
        const result = await subscribe(email);
        assert.equal(result.statusCode, 202);
        assert.deepEqual(JSON.parse(result.body), ACCEPTED);
        await app.diContainer.cradle.confirmationSendsService.drain();

        const row = await rowFor(email);
        ids.push(row.id);
        assert.equal(row.status, 'pending');
        assert.ok(row.confirmation_sent_at);
        assert.ok(!logs.lines.some((line) => line.includes(email)));
      }
      const warned = logs
        .entries()
        .filter(
          (entry) =>
            entry.msg === 'confirmation email not sent' &&
            ids.includes(entry.subscriberId as string),
        );
      assert.equal(warned.length, 2);
      assert.equal(warned[0].level, 40);
      assert.equal(warned[0].diagnostic, 'SMTP 550');
      assert.equal(warned[0].orgId, orgId);
      assert.ok(warned[0].subscriberId);
    } finally {
      sender.send = original;
    }
  });

  it('waits for a send in flight before app.close() resolves', async () => {
    const closing = await buildApp({ logger: false });
    await closing.ready();
    const sender = closing.diContainer.resolve('emailSender') as EmailSender;
    let settledAt = 0;
    sender.send = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          settledAt = Date.now();
          resolve({ outcome: 'accepted' });
        }, 300);
      });
    const result = await subscribe(uniqueRecipient('close'), tag, {}, closing);
    assert.equal(result.statusCode, 202, result.body);
    assert.equal(settledAt, 0);

    await closing.close();
    const closedAt = Date.now();
    assert.ok(settledAt > 0, 'the send settled before close() resolved');
    assert.ok(settledAt <= closedAt);
  });

  it('rations the route by client IP, with Retry-After and the public headers', async () => {
    const limited = await buildApp({ logger: false });
    await limited.ready();
    try {
      let last: Awaited<ReturnType<typeof limited.inject>> | undefined;
      for (let sent = 0; sent <= env.subscribe.rateLimit.max; sent += 1) {
        last = await limited.inject({
          method: 'POST',
          url: `/status/${tag}/subscribers`,
          payload: { email: uniqueRecipient('limit') },
          remoteAddress: '10.8.8.8',
        });
        if (sent < env.subscribe.rateLimit.max) {
          assert.equal(last.statusCode, 202, last.body);
        }
      }
      assert.equal(last?.statusCode, 429);
      assert.ok(last.headers['retry-after']);
      assert.equal(last.headers['access-control-allow-origin'], '*');
      assert.equal(
        last.headers['access-control-expose-headers'],
        'ETag, Retry-After',
      );
      await limited.diContainer.cradle.confirmationSendsService.drain();
    } finally {
      await limited.close();
    }
  });
});
