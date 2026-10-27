import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { env } from '@/config';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  type MailpitMessage,
  messagesTo,
  uniqueRecipient,
} from '@/shared/testing/mailpit';
import {
  displayNameFor,
  signUpWithOrg,
  TEST_ORIGIN,
} from '@/shared/testing/tenant';
import { runNotificationPass } from '@/worker';
import type { ICustomWorld } from '../support/custom-world';

/**
 * Story 6.10: subscribe, confirm, notify and unsubscribe as one flow through
 * the listening app, reading what a visitor would read from Mailpit.
 *
 * Sabotage map (each makes `pnpm run test:e2e` fail at the step named):
 * - every `status = 'confirmed'` check removed (`lockConfirmed`, the
 *   `insertPending` join, `confirmedAddress`): "the first visitor has exactly
 *   1 notification" after U2 sees a second one.
 * - `s.confirmed_at < o.recorded_at` removed: "the first visitor has exactly 1
 *   notification" sees the incident's opening entry as a second one.
 * - `unsubscribe` no longer changes the status: same step, A receives U2.
 * - every `status = 'confirmed'` check removed, and the comparison made to
 *   treat a null `confirmed_at` as earliest (`coalesce(s.confirmed_at,
 *   '-infinity')`): "the third visitor has exactly 0 notifications" (and the
 *   first visitor's count after U2). Removing the comparison instead fails
 *   scenario 2 one step earlier, at the fourth visitor's count, which then
 *   includes the opening entry.
 * - the signature corrupted in `unsubscribeLink` (shared by body and header):
 *   fails at "the unsubscribe link answered that they are unsubscribed".
 * - the pass call removed: "the notification pass runs until ..." never sees
 *   the control's notification.
 * - `on conflict ... do nothing` removed from `insertPending`: the second
 *   pass rejects (23505), failing "the notification pass runs until ...".
 */

type Visitor = { email: string };

const PASS_DISPATCH_BUDGET_MS = 30_000;

async function adminPost(world: ICustomWorld, path: string, payload = {}) {
  const response = await world.server.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { cookie: world.context.cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.ok(response.statusCode < 300, `POST ${path}: ${response.body}`);
  return JSON.parse(response.body) as { id: string };
}

/**
 * Waits until the database clock is 2 s past `since`, because the WSL clock
 * steps back by up to 1.4 s and confirmation and recording are compared by
 * `now()`.
 */
async function waitPast(world: ICustomWorld, since: Date | null) {
  assert.ok(since, 'there is a stored time to wait past');
  const deadline = Date.now() + 15_000;
  for (;;) {
    const [{ ok }] = await withTenantTransaction(
      world.context.orgId,
      (tx) =>
        tx.sql<{ ok: boolean }[]>`
          select clock_timestamp() > ${since}::timestamptz + interval '2 seconds' as ok`,
    );
    if (ok) return;
    assert.ok(Date.now() < deadline, 'the database clock did not move on');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function visitor(world: ICustomWorld, label: string): Visitor {
  const found = world.context.visitors[label];
  assert.ok(found, `no ${label} visitor has subscribed`);
  return found;
}

const isConfirmation = (m: MailpitMessage) =>
  m.Subject.startsWith('Confirm your subscription');

async function notificationsOf(world: ICustomWorld, label: string) {
  const messages = await messagesTo(visitor(world, label).email);
  return messages.filter((m) => !isConfirmation(m));
}

/** The one notification whose body holds `message`. */
async function notificationAbout(
  world: ICustomWorld,
  label: string,
  message: string,
) {
  const found = (await notificationsOf(world, label)).filter((m) =>
    m.Text.includes(message),
  );
  assert.equal(found.length, 1, `exactly one notification holds "${message}"`);
  return found[0];
}

/** The visitor follows an emailed link over the real socket. */
async function follow(world: ICustomWorld, link: string) {
  const url = new URL(link);
  assert.equal(url.origin, new URL(env.publicBaseUrl).origin);
  const response = await fetch(world.baseUrl + url.pathname + url.search);
  return { status: response.status, body: await response.text() };
}

Given(
  'an organization with a public service and an active incident',
  async function (this: ICustomWorld) {
    const slug = `e2e-${randomBytes(4).toString('hex')}`;
    const { cookie, userId, orgId } = await signUpWithOrg(this.server, slug);
    Object.assign(this.context, {
      slug,
      cookie,
      userId,
      orgId,
      orgName: displayNameFor(slug),
      visitors: {},
      incidentTitle: 'Elevated API errors',
    });
    const { id: serviceId } = await adminPost(this, '/services', {
      name: 'API',
      slug: `${slug}-api`,
    });
    const incident = await adminPost(this, '/incidents', {
      title: this.context.incidentTitle,
      impact: 'minor',
      affectedServices: [{ serviceId, impact: 'minor' }],
    });
    this.context.incidentId = incident.id;
  },
);

// Guard 1: the opening entry must not be owed to anyone who confirms next.
Given(
  "the clock is past the incident's opening entry",
  async function (this: ICustomWorld) {
    const [{ latest }] = await withTenantTransaction(
      this.context.orgId,
      (tx) =>
        tx.sql<{ latest: Date | null }[]>`
          select max(created_at) as latest from incident_updates`,
    );
    assert.ok(latest, 'the organization has an incident update');
    await waitPast(this, latest);
  },
);

When(
  'the {word} visitor subscribes',
  async function (this: ICustomWorld, label: string) {
    const email = uniqueRecipient(label);
    this.context.visitors[label] = { email };
    // A remote address of its own per request: the subscribe limit is 5 an
    // hour per client IP, held in memory by the one app the whole run shares,
    // and every socket request arrives from 127.0.0.1. Defensive only; the
    // limit itself is story 6.3's to prove.
    const response = await this.server.inject({
      method: 'POST',
      url: `/status/${this.context.slug}/subscribers`,
      remoteAddress: `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
      payload: { email },
    });
    assert.equal(response.statusCode, 202, response.body);
    const mails = await messagesTo(email, { atLeast: 1, timeoutMs: 5_000 });
    assert.equal(mails.length, 1);
    assert.equal(
      mails[0].Subject,
      `Confirm your subscription to ${this.context.orgName} status updates`,
    );
  },
);

When(
  'the {word} visitor opens the link in the confirmation email',
  async function (this: ICustomWorld, label: string) {
    const [mail] = (await messagesTo(visitor(this, label).email)).filter(
      isConfirmation,
    );
    assert.ok(mail, 'the visitor has a confirmation email');
    const link = mail.Text.match(/^https?:\/\/\S+$/m)?.[0];
    assert.ok(link, 'the confirmation email holds a link');
    const answer = await follow(this, link);
    assert.equal(answer.status, 200);
    assert.equal(
      answer.body,
      `Your subscription to ${this.context.orgName} status updates is confirmed.`,
    );
  },
);

Then(
  "the {word} visitor's subscription is confirmed",
  async function (this: ICustomWorld, label: string) {
    const email = visitor(this, label).email;
    const rows = await withTenantTransaction(
      this.context.orgId,
      (tx) =>
        tx.sql<{ status: string }[]>`
          select status from subscribers where email = ${email}`,
    );
    assert.deepEqual(
      rows.map((r) => r.status),
      ['confirmed'],
    );
  },
);

// Guard 2: the update must be recorded after every confirmation.
When(
  'the clock is past the last confirmation',
  async function (this: ICustomWorld) {
    const [{ latest }] = await withTenantTransaction(
      this.context.orgId,
      (tx) =>
        tx.sql<{ latest: Date | null }[]>`
        select max(confirmed_at) as latest from subscribers`,
    );
    await waitPast(this, latest);
  },
);

When(
  'the operator posts the update {string}',
  async function (this: ICustomWorld, message: string) {
    await adminPost(this, `/incidents/${this.context.incidentId}/updates`, {
      message,
    });
    this.context.lastMessage = message;
  },
);

// The pass sends before it returns. A clock step inside it can leave owed rows
// not yet due, so rerun the same scoped pass, at most twice more, until every
// listed visitor has its count. A rerun only sends what is already owed; the
// exact-count steps that follow still catch a duplicate or a wrong recipient.
When(
  /^the notification pass runs until (.+)$/,
  { timeout: 120_000 },
  async function (this: ICustomWorld, spec: string) {
    const wanted = [
      ...spec.matchAll(/the (\w+) visitor has (\d+) notifications?/g),
    ].map(([, label, count]) => ({ label, count: Number(count) }));
    assert.ok(wanted.length > 0, `no visitor named in "${spec}"`);
    let short = '';
    for (let run = 0; run < 3; run++) {
      await runNotificationPass(this.server, this.server.log, {
        orgIds: [this.context.orgId],
        dispatchBudgetMs: PASS_DISPATCH_BUDGET_MS,
      });
      const deadline = Date.now() + 3_000;
      for (;;) {
        const counts = await Promise.all(
          wanted.map(async (w) => ({
            ...w,
            have: (await notificationsOf(this, w.label)).length,
          })),
        );
        const missing = counts.filter((c) => c.have < c.count);
        if (missing.length === 0) return;
        short = missing
          .map((c) => `the ${c.label} visitor has ${c.have}, not ${c.count}`)
          .join('; ');
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.fail(short);
  },
);

Then(
  /^the (\w+) visitor has exactly (\d+) notifications?$/,
  async function (this: ICustomWorld, label: string, count: string) {
    assert.equal((await notificationsOf(this, label)).length, Number(count));
  },
);

Then(
  /^the (\w+) visitor has exactly (\d+) confirmation emails?$/,
  async function (this: ICustomWorld, label: string, count: string) {
    const mails = await messagesTo(visitor(this, label).email);
    assert.equal(mails.filter(isConfirmation).length, Number(count));
  },
);

function unsubscribeUrlOf(mail: MailpitMessage) {
  const url = mail.Text.match(/unsubscribe: (\S+)/)?.[1];
  assert.ok(url, 'the notification body holds an unsubscribe link');
  return url;
}

Then(
  "the {word} visitor's notification is for that update",
  async function (this: ICustomWorld, label: string) {
    const mail = await notificationAbout(this, label, this.context.lastMessage);
    assert.equal(
      mail.Subject,
      `[${this.context.orgName}] ${this.context.incidentTitle}: Investigating`,
    );
    assert.ok(mail.Text.includes(this.context.lastMessage));
    const header = mail.Headers['List-Unsubscribe']?.[0];
    assert.ok(header, 'List-Unsubscribe is present');
    assert.equal(header.replace(/^<|>$/g, ''), unsubscribeUrlOf(mail));
    assert.deepEqual(mail.Headers['List-Unsubscribe-Post'], [
      'List-Unsubscribe=One-Click',
    ]);
  },
);

Then(
  /^the (\w+) visitor's notifications hold "([^"]+)" once and "([^"]+)" once$/,
  async function (this: ICustomWorld, label: string, one: string, two: string) {
    const mails = await notificationsOf(this, label);
    for (const message of [one, two]) {
      assert.equal(
        mails.filter((m) => m.Text.includes(message)).length,
        1,
        `exactly one notification holds "${message}"`,
      );
    }
  },
);

When(
  'the {word} visitor opens the unsubscribe link in the notification',
  async function (this: ICustomWorld, label: string) {
    const mail = await notificationAbout(this, label, this.context.lastMessage);
    this.context.unsubscribeAnswer = await follow(this, unsubscribeUrlOf(mail));
  },
);

Then(
  'the unsubscribe link answered that they are unsubscribed',
  function (this: ICustomWorld) {
    assert.equal(this.context.unsubscribeAnswer.status, 200);
    assert.equal(
      this.context.unsubscribeAnswer.body,
      `You are unsubscribed from ${this.context.orgName} status updates.`,
    );
  },
);
