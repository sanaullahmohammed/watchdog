import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import {
  signUnsubscribe,
  unsubscribeLink,
} from '@/modules/notification/domain/unsubscribe-link';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  subscriberConfirmedEvent,
  subscriberUnsubscribedEvent,
} from '@/shared/events/subscriber.events';
import { capturing } from '@/shared/testing/events';
import { captureLogs } from '@/shared/testing/logs';
import { messagesTo, uniqueRecipient } from '@/shared/testing/mailpit';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 6.4: confirm and unsubscribe through the emailed links. Confirm links
 * come from Mailpit after a real subscribe; unsubscribe links are built with
 * `unsubscribeLink` and the configured secret.
 */

const tag = `lnk-${randomBytes(4).toString('hex')}`;
const otherTag = `${tag}-b`;

const INVALID =
  'This link is not valid. It may have expired or already been used.';

type Row = {
  id: string;
  status: string;
  confirmation_token_hash: string | null;
  confirmed_at: Date | null;
};

let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;
let orgId = '';
let userId = '';
let otherOrgId = '';
let otherUserId = '';
let octet = 0;

const ip = () => {
  octet += 1;
  return `10.${(octet >> 16) & 255}.${(octet >> 8) & 255}.${octet & 255}`;
};

const call = (
  method: 'GET' | 'HEAD' | 'POST',
  url: string,
  extra: { headers?: Record<string, string>; payload?: string } = {},
) => app.inject({ method, url, remoteAddress: ip(), ...extra });

const subscribe = (email: string, slug = tag) =>
  app.inject({
    method: 'POST',
    url: `/status/${slug}/subscribers`,
    payload: { email },
    remoteAddress: ip(),
  });

const rowFor = (email: string, org = orgId) =>
  withTenantTransaction(org, async ({ sql: tx }) => {
    const rows = await tx<Row[]>`
      select id, status, confirmation_token_hash, confirmed_at
      from subscribers where lower(email) = ${email.toLowerCase()}
    `;
    return rows[0];
  });

/** Subscribes for real and returns the confirm path from the email. */
const subscribeForLink = async (slug = tag) => {
  const email = uniqueRecipient('lnk');
  const res = await subscribe(email, slug);
  assert.equal(res.statusCode, 202, res.body);
  await app.diContainer.cradle.confirmationSendsService.drain();
  const [message] = await messagesTo(email, { atLeast: 1, timeoutMs: 2_000 });
  const match = message.Text.match(/(\/status\/[^\s]+\/confirm\?token=[\w-]+)/);
  assert.ok(match, 'the email carries the confirm link');
  return { email, path: match[1] };
};

const unsubscribePath = (
  subscriberId: string,
  slug = tag,
  org = orgId,
  secret = env.notificationLinkSecret,
) => unsubscribeLink('', slug, org, subscriberId, secret);

const seedRow = (email: string, status: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ id: string }[]>`
      insert into subscribers (org_id, email, status, confirmation_token_hash)
      values (${orgId}, ${email}, ${status}, 'seeded-hash')
      returning id
    `;
    return rows[0].id;
  });

const expectInvalid = (res: {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}) => {
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.body, INVALID);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
};

describe('Story 6.4: confirm and unsubscribe through the emailed links', () => {
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

  describe('confirm', () => {
    it('confirms a pending row from the real link, once', async () => {
      const { email, path } = await subscribeForLink();
      const before = await rowFor(email);
      assert.equal(before.status, 'pending');

      const { result, captured } = await capturing(
        app,
        subscriberConfirmedEvent.type,
        () => call('GET', path),
      );
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(
        result.body,
        `Your subscription to ${tag} Display Name status updates is confirmed.`,
      );
      assert.equal(result.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers.etag, undefined);
      assert.equal(result.headers['access-control-allow-origin'], '*');

      const row = await rowFor(email);
      assert.equal(row.status, 'confirmed');
      assert.ok(row.confirmed_at);
      assert.equal(row.confirmation_token_hash, null);
      assert.equal(captured.length, 1);
      assert.deepEqual((captured[0] as { payload: unknown }).payload, {
        orgId,
        subscriberId: row.id,
      });

      // Used: the same link is now the uniform miss, with no second event.
      const again = await capturing(app, subscriberConfirmedEvent.type, () =>
        call('GET', path),
      );
      expectInvalid(again.result);
      assert.equal(again.captured.length, 0);
    });

    it('refuses an expired token and leaves the row alone', async () => {
      const { email, path } = await subscribeForLink();
      await withTenantTransaction(
        orgId,
        ({ sql: tx }) => tx`
          update subscribers
          set confirmation_expires_at = now() - interval '1 second'
          where lower(email) = ${email}
        `,
      );
      const { result, captured } = await capturing(
        app,
        subscriberConfirmedEvent.type,
        () => call('GET', path),
      );
      expectInvalid(result);
      assert.equal(captured.length, 0);
      assert.equal((await rowFor(email)).status, 'pending');
    });

    it('refuses the token of a non-pending row', async () => {
      const { email, path } = await subscribeForLink();
      await withTenantTransaction(
        orgId,
        ({ sql: tx }) => tx`
          update subscribers set status = 'unsubscribed'
          where lower(email) = ${email}
        `,
      );
      expectInvalid(await call('GET', path));
      assert.equal((await rowFor(email)).status, 'unsubscribed');
    });

    it("refuses another organization's slug with a real token", async () => {
      const { email, path } = await subscribeForLink();
      const crossed = path.replace(`/status/${tag}/`, `/status/${otherTag}/`);
      expectInvalid(await call('GET', crossed));
      assert.equal((await rowFor(email)).status, 'pending');
    });

    it('gives one uniform answer for every malformed or missing input', async () => {
      const base = `/status/${tag}/subscribers/confirm`;
      for (const url of [
        base,
        `${base}?token=`,
        `${base}?token=short`,
        `${base}?token=${'a'.repeat(44)}`,
        `${base}?token=${'a'.repeat(42)}!`,
        `${base}?token=${'a'.repeat(43)}`,
        `${base}?token=a&token=b`,
        `/status/no-such-org-${tag}/subscribers/confirm?token=${'a'.repeat(43)}`,
        `/status/Bad_Slug/subscribers/confirm?token=${'a'.repeat(43)}`,
      ]) {
        expectInvalid(await call('GET', url));
      }
    });

    it('lets two concurrent confirms produce one success and one event', async () => {
      const { email, path } = await subscribeForLink();
      const { result, captured } = await capturing(
        app,
        subscriberConfirmedEvent.type,
        () => Promise.all([call('GET', path), call('GET', path)]),
      );
      assert.deepEqual(result.map((r) => r.statusCode).sort(), [200, 404]);
      assert.equal(captured.length, 1);
      assert.equal((await rowFor(email)).status, 'confirmed');
    });

    it('answers HEAD 200 with an empty body and consumes nothing', async () => {
      const { email, path } = await subscribeForLink();
      const head = await call('HEAD', path);
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      assert.match(String(head.headers['content-type']), /^text\/plain/);
      const bad = await call(
        'HEAD',
        `/status/${tag}/subscribers/confirm?token=x`,
      );
      assert.equal(bad.statusCode, 200);
      assert.equal(bad.body, '');
      assert.equal((await rowFor(email)).status, 'pending');
      // The token still works afterwards.
      assert.equal((await call('GET', path)).statusCode, 200);
    });

    it('has no OPTIONS route of its own: a preflight gets the catch-all miss', async () => {
      for (const kind of ['confirm', 'unsubscribe']) {
        const res = await app.inject({
          method: 'OPTIONS',
          url: `/status/${tag}/subscribers/${kind}`,
          remoteAddress: ip(),
        });
        assert.equal(res.statusCode, 404);
        assert.equal(res.headers['access-control-allow-methods'], undefined);
      }
    });
  });

  describe('unsubscribe', () => {
    for (const status of ['confirmed', 'pending'] as const) {
      for (const method of ['GET', 'POST'] as const) {
        it(`unsubscribes a ${status} row by ${method}`, async () => {
          const email = uniqueRecipient('un');
          const id = await seedRow(email, status);
          const { result, captured } = await capturing(
            app,
            subscriberUnsubscribedEvent.type,
            () => call(method, unsubscribePath(id)),
          );
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(
            result.body,
            `You are unsubscribed from ${tag} Display Name status updates.`,
          );
          assert.equal(
            result.headers['content-type'],
            'text/plain; charset=utf-8',
          );
          assert.equal(result.headers['cache-control'], 'no-store');
          assert.equal(result.headers['access-control-allow-origin'], '*');
          const row = await rowFor(email);
          assert.equal(row.status, 'unsubscribed');
          assert.equal(row.confirmation_token_hash, null);
          assert.equal(captured.length, 1);
          assert.deepEqual((captured[0] as { payload: unknown }).payload, {
            orgId,
            subscriberId: id,
          });
        });
      }
    }

    it('answers the same text again, with no second event', async () => {
      const email = uniqueRecipient('un');
      const id = await seedRow(email, 'confirmed');
      const first = await call('GET', unsubscribePath(id));
      const { result, captured } = await capturing(
        app,
        subscriberUnsubscribedEvent.type,
        () => call('GET', unsubscribePath(id)),
      );
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, first.body);
      assert.equal(captured.length, 0);
    });

    it('lets two concurrent unsubscribes both answer 200 with one event', async () => {
      const id = await seedRow(uniqueRecipient('un'), 'confirmed');
      const { result, captured } = await capturing(
        app,
        subscriberUnsubscribedEvent.type,
        () =>
          Promise.all([
            call('GET', unsubscribePath(id)),
            call('POST', unsubscribePath(id)),
          ]),
      );
      assert.deepEqual(
        result.map((r) => r.statusCode),
        [200, 200],
      );
      assert.equal(captured.length, 1);
    });

    it('refuses a wrong signature, another organization and a deleted subscriber', async () => {
      const email = uniqueRecipient('un');
      const id = await seedRow(email, 'confirmed');
      const good = unsubscribePath(id);
      const flipped = good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      const wrongSecret = unsubscribePath(
        id,
        tag,
        orgId,
        'another-secret-of-at-least-32-characters',
      );
      const otherOrgSigned = unsubscribePath(id, tag, otherOrgId);
      const { captured } = await capturing(
        app,
        subscriberUnsubscribedEvent.type,
        async () => {
          for (const path of [flipped, wrongSecret, otherOrgSigned]) {
            expectInvalid(await call('GET', path));
            expectInvalid(await call('POST', path));
          }
          // The row of this org, addressed through the other org's slug.
          expectInvalid(
            await call('GET', unsubscribePath(id, otherTag, otherOrgId)),
          );
          const gone = await seedRow(uniqueRecipient('un'), 'confirmed');
          await withTenantTransaction(
            orgId,
            ({ sql: tx }) => tx`delete from subscribers where id = ${gone}`,
          );
          expectInvalid(await call('GET', unsubscribePath(gone)));
        },
      );
      assert.equal(captured.length, 0);
      assert.equal((await rowFor(email)).status, 'confirmed');
    });

    it('gives one uniform answer for malformed or missing input and unknown slugs', async () => {
      const id = await seedRow(uniqueRecipient('un'), 'confirmed');
      const sig = unsubscribePath(id).split('signature=')[1];
      const base = `/status/${tag}/subscribers/unsubscribe`;
      for (const url of [
        base,
        `${base}?subscriber=${id}`,
        `${base}?signature=${sig}`,
        `${base}?subscriber=not-a-uuid&signature=${signUnsubscribe(env.notificationLinkSecret, orgId, 'not-a-uuid')}`,
        `${base}?subscriber=${id}&signature=short`,
        `${base}?subscriber=${id}&signature=${sig}${sig}`,
        `/status/nope-${tag}/subscribers/unsubscribe?subscriber=${id}&signature=${sig}`,
      ]) {
        expectInvalid(await call('GET', url));
        expectInvalid(await call('POST', url));
      }
    });

    it('accepts RFC 8058 one-click POSTs in any body shape', async () => {
      const shapes: { headers?: Record<string, string>; payload?: string }[] = [
        {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'List-Unsubscribe=One-Click',
        },
        {
          headers: {
            'content-type': 'multipart/form-data; boundary=xyz',
          },
          payload:
            '--xyz\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--xyz--\r\n',
        },
        {},
        { headers: { 'content-type': 'application/json' }, payload: '' },
        { headers: { 'content-type': 'text/weird' }, payload: 'x' },
      ];
      for (const shape of shapes) {
        const id = await seedRow(uniqueRecipient('un'), 'confirmed');
        const res = await call('POST', unsubscribePath(id), shape);
        assert.equal(
          res.statusCode,
          200,
          `${JSON.stringify(shape)} ${res.body}`,
        );
      }
    });

    it('refuses a body over 1 KiB with the public headers', async () => {
      const email = uniqueRecipient('un');
      const id = await seedRow(email, 'confirmed');
      const { result: res, captured } = await capturing(
        app,
        subscriberUnsubscribedEvent.type,
        () =>
          call('POST', unsubscribePath(id), {
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            payload: 'a'.repeat(2048),
          }),
      );
      assert.equal(res.statusCode, 413);
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal((await rowFor(email)).status, 'confirmed');
      await app.eventBus.drain();
      assert.equal(captured.length, 0);
    });

    it('answers HEAD 200 with an empty body and changes nothing', async () => {
      const email = uniqueRecipient('un');
      const id = await seedRow(email, 'confirmed');
      const head = await call('HEAD', unsubscribePath(id));
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      const bad = await call(
        'HEAD',
        `/status/${tag}/subscribers/unsubscribe?subscriber=x`,
      );
      assert.equal(bad.statusCode, 200);
      assert.equal(bad.body, '');
      assert.match(String(bad.headers['content-type']), /^text\/plain/);
      assert.equal((await rowFor(email)).status, 'confirmed');
    });

    it('kills a pending confirm link, and a resubscribe can confirm again', async () => {
      const { email, path } = await subscribeForLink();
      const row = await rowFor(email);
      assert.equal(
        (await call('GET', unsubscribePath(row.id))).statusCode,
        200,
      );
      expectInvalid(await call('GET', path));
      assert.equal((await rowFor(email)).status, 'unsubscribed');

      // Move the throttle stamp back, then subscribe again.
      await withTenantTransaction(
        orgId,
        ({ sql: tx }) => tx`
          update subscribers
          set confirmation_sent_at = now() - interval '1 day'
          where lower(email) = ${email}
        `,
      );
      assert.equal((await subscribe(email)).statusCode, 202);
      await app.diContainer.cradle.confirmationSendsService.drain();
      const messages = await messagesTo(email, {
        atLeast: 2,
        timeoutMs: 2_000,
      });
      const last = messages
        .map((m) => m.Text.match(/(\/status\/[^\s]+\/confirm\?token=[\w-]+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1])
        .find((p) => p !== path);
      assert.ok(last, 'a new confirm link was emailed');
      assert.equal((await call('GET', last)).statusCode, 200);
      assert.equal((await rowFor(email)).status, 'confirmed');
    });
  });

  describe('rate limit', () => {
    it('rations both links by client IP, HEAD sharing the GET bucket', async () => {
      const limited = await buildApp({ logger: false });
      await limited.ready();
      const max = env.publicSurface.rateLimit.max;
      const expect429 = (res: {
        statusCode: number;
        headers: Record<string, unknown>;
      }) => {
        assert.equal(res.statusCode, 429);
        assert.ok(res.headers['retry-after']);
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.equal(
          res.headers['access-control-expose-headers'],
          'ETag, Retry-After',
        );
        assert.equal(res.headers['cache-control'], 'no-store');
      };
      try {
        const email = uniqueRecipient('un');
        const id = await seedRow(email, 'confirmed');
        const cases = [
          {
            address: '10.9.9.1',
            url: `/status/${tag}/subscribers/confirm?token=${'c'.repeat(43)}`,
          },
          { address: '10.9.9.2', url: unsubscribePath(id) },
        ];
        for (const { address, url } of cases) {
          const send = (method: 'GET' | 'HEAD') =>
            limited.inject({ method, url, remoteAddress: address });
          for (let sent = 0; sent < max; sent += 1) {
            // The unsubscribe link is valid and changes the row on the first
            // answer only; the rest are ordinary answers inside the limit.
            assert.notEqual((await send('GET')).statusCode, 429);
          }
          expect429(await send('GET'));
          expect429(await send('HEAD'));
        }
        // The unsubscribe case spent its quota on a valid link: it changed
        // the row once, before the limit. A refused one changes nothing.
        await withTenantTransaction(
          orgId,
          ({ sql: tx }) =>
            tx`update subscribers set status = 'confirmed' where id = ${id}`,
        );
        expect429(
          await limited.inject({
            method: 'GET',
            url: unsubscribePath(id),
            remoteAddress: '10.9.9.2',
          }),
        );
        assert.equal((await rowFor(email)).status, 'confirmed');
      } finally {
        await limited.close();
      }
    });
  });

  describe('logs', () => {
    it('carry neither a token nor a signature', async () => {
      const { path } = await subscribeForLink();
      const token = path.split('token=')[1];
      const id = await seedRow(uniqueRecipient('un'), 'confirmed');
      const signature = unsubscribePath(id).split('signature=')[1];
      await call('GET', path);
      await call('GET', unsubscribePath(id));
      await call('POST', unsubscribePath(id));
      await call(
        'GET',
        `/status/${tag}/subscribers/confirm?token=${'z'.repeat(43)}`,
      );
      await app.eventBus.drain();

      const requestLines = logs
        .entries()
        .filter(
          (e) => e.msg === 'incoming request' || e.msg === 'request completed',
        );
      assert.ok(requestLines.length > 0, 'request lines were captured');
      const sha = createHash('sha256').update(token).digest('hex');
      for (const line of logs.lines) {
        assert.ok(!line.includes(token), 'token in a log line');
        assert.ok(!line.includes(signature), 'signature in a log line');
        assert.ok(!line.includes(sha), 'token hash in a log line');
        assert.ok(!line.includes('z'.repeat(43)), 'query value in a log line');
      }
      const confirmLine = requestLines.find((e) =>
        String((e.req as { url?: string } | undefined)?.url).endsWith(
          '/subscribers/confirm',
        ),
      );
      assert.ok(confirmLine, 'the url is logged without its query');
    });
  });
});
