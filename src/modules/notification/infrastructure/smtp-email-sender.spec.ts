import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import type { SendResult } from '@/modules/notification/domain/email-sender.port';
import {
  classifySmtpFailure,
  createSmtpEmailSender,
  SMTP_TIMEOUTS,
  type SmtpSettings,
  type SmtpTimeouts,
} from '@/modules/notification/infrastructure/smtp-email-sender';
import {
  closedPort,
  type SmtpStub,
  type SmtpStubOptions,
  startSmtpStub,
} from '@/shared/testing/smtp-stub';
import { createTestCa } from '@/shared/testing/test-certificates';

/**
 * Story 6.2: the SMTP adapter against a local stub, for every row of the
 * matrix except "Delivered", which is Mailpit's (decision D15). No database,
 * no `.env`.
 */

const RECIPIENT = 'jane.doe+status@example.org';

const stubs: SmtpStub[] = [];

// A login needs STARTTLS (requireTLS), so the stub that takes one upgrades
// with a leaf from a throwaway CA, which this process alone trusts while the
// file runs.
const defaultCas = getCACertificates('default');
let starttls: { key: string; cert: string };
before(() => {
  const ca = createTestCa();
  const leaf = ca.issue({
    ip: ['127.0.0.1'],
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 86_400_000),
  });
  starttls = { key: leaf.keyPem, cert: leaf.certPem };
  setDefaultCACertificates([...defaultCas, ca.caPem]);
});

after(async () => {
  setDefaultCACertificates(defaultCas);
  await Promise.all(stubs.map((stub) => stub.close()));
});

const quick: Partial<SmtpTimeouts> = {
  dns: 1_000,
  connection: 1_000,
  greeting: 1_000,
  socket: 1_000,
  overall: 5_000,
};

const settingsFor = (
  port: number,
  overrides: Partial<SmtpSettings> = {},
): SmtpSettings => ({
  host: '127.0.0.1',
  port,
  secure: false,
  from: 'WatchDog <watchdog@localhost>',
  ...overrides,
});

const sendThrough = async (
  options: SmtpStubOptions,
  {
    settings,
    timeouts = quick,
  }: {
    settings?: Partial<SmtpSettings>;
    timeouts?: Partial<SmtpTimeouts>;
  } = {},
) => {
  const stub = await startSmtpStub(options);
  stubs.push(stub);
  const sender = createSmtpEmailSender(
    settingsFor(stub.port, settings),
    timeouts,
  );
  const result = await sender.send({
    to: RECIPIENT,
    subject: 'Status update',
    text: 'Something changed.',
    headers: { 'List-Unsubscribe': '<https://example.org/u>' },
  });
  return { result, stub };
};

/** Neither the address nor any part of it may reach a diagnostic. */
const assertNoRecipient = (result: SendResult) => {
  const serialised = JSON.stringify(result);
  for (const part of [RECIPIENT, 'jane', 'example.org']) {
    assert.equal(serialised.includes(part), false, serialised);
  }
};

const login = { auth: { user: 'mailer', pass: 's3cret' } };

describe('story 6.2: the SMTP sender against a stub', () => {
  it('reports accepted when the stub takes the message', async () => {
    const { result, stub } = await sendThrough({});
    assert.deepEqual(result, { outcome: 'accepted' });
    assert.ok(stub.commands.includes('DATA'));
  });

  it('reports a 450 to RCPT as transient, SMTP 450', async () => {
    const { result } = await sendThrough({ rcptTo: 450 });
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'SMTP 450' });
    assertNoRecipient(result);
  });

  it('reports a 550 to RCPT as permanent, SMTP 550', async () => {
    const { result } = await sendThrough({ rcptTo: 550 });
    assert.deepEqual(result, { outcome: 'permanent', diagnostic: 'SMTP 550' });
    assertNoRecipient(result);
  });

  it('reports a 554 after DATA as permanent, and a 451 there as transient', async () => {
    const refused = await sendThrough({ data: 554 });
    assert.deepEqual(refused.result, {
      outcome: 'permanent',
      diagnostic: 'SMTP 554',
    });
    assertNoRecipient(refused.result);

    const deferred = await sendThrough({ data: 451 });
    assert.deepEqual(deferred.result, {
      outcome: 'transient',
      diagnostic: 'SMTP 451',
    });
  });

  it('reports a 535 to AUTH as transient: our settings are wrong', async () => {
    const { result, stub } = await sendThrough(
      { auth: 535, starttls },
      { settings: login },
    );
    assert.ok(stub.commands.includes('STARTTLS'));
    assert.ok(stub.commands.some((line) => line.startsWith('AUTH PLAIN')));
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'SMTP 535' });
    assertNoRecipient(result);
  });

  it('never sends a login in cleartext to a server that offers no STARTTLS', async () => {
    const { result, stub } = await sendThrough({}, { settings: login });
    assert.equal(result.outcome, 'transient');
    assert.equal(
      stub.commands.some((line) => line.toUpperCase().startsWith('AUTH')),
      false,
      stub.commands.join(' | '),
    );
    assertNoRecipient(result);
  });

  it('reports a 550 to MAIL FROM as transient: our settings are wrong', async () => {
    const { result } = await sendThrough({ mailFrom: 550 });
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'SMTP 550' });
    assertNoRecipient(result);
  });

  it('reports a 554 greeting as transient, SMTP 554', async () => {
    const { result } = await sendThrough({ greeting: 554 });
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'SMTP 554' });
    assertNoRecipient(result);
  });

  it('reports a refused connection as transient, ESOCKET', async () => {
    const sender = createSmtpEmailSender(
      settingsFor(await closedPort()),
      quick,
    );
    const result = await sender.send({
      to: RECIPIENT,
      subject: 's',
      text: 't',
    });
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'ESOCKET' });
    assertNoRecipient(result);
  });

  it('reports a missing greeting as transient, ETIMEDOUT', async () => {
    const started = performance.now();
    const { result } = await sendThrough(
      { greeting: 'never' },
      { timeouts: { ...quick, greeting: 200, socket: 2_000 } },
    );
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'ETIMEDOUT' });
    assert.ok(performance.now() - started < 2_000);
  });

  it('reports a server that stops replying as transient, ETIMEDOUT, at the inactivity timeout', async () => {
    const started = performance.now();
    const { result, stub } = await sendThrough(
      { silentAfter: 'EHLO' },
      { timeouts: { ...quick, socket: 300, overall: 3_000 } },
    );
    const elapsed = performance.now() - started;
    assert.ok(stub.commands.some((line) => line.startsWith('MAIL FROM')));
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'ETIMEDOUT' });
    assert.ok(elapsed < 2_000, String(elapsed));
  });

  it('gives up at the overall limit although every reply beats the inactivity timeout', async () => {
    const started = performance.now();
    const { result } = await sendThrough(
      { replyDelayMs: 200 },
      {
        timeouts: {
          ...quick,
          greeting: 1_000,
          socket: 400,
          overall: 500,
        },
      },
    );
    const elapsed = performance.now() - started;
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'EDEADLINE' });
    assert.ok(elapsed >= 450 && elapsed < 1_000, String(elapsed));
  });

  it('never throws, even when nodemailer refuses the message locally', async () => {
    const stub = await startSmtpStub({});
    stubs.push(stub);
    const sender = createSmtpEmailSender(settingsFor(stub.port), quick);
    const result = await sender.send({
      to: 'not an address',
      subject: 's',
      text: 't',
    });
    assert.deepEqual(result, { outcome: 'transient', diagnostic: 'EENVELOPE' });
    assert.equal(JSON.stringify(result).includes('not an address'), false);
  });

  it('catches the abandoned send when it fails after the deadline', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const { result, stub } = await sendThrough(
        { replyDelayMs: 200 },
        { timeouts: { ...quick, socket: 5_000, overall: 300 } },
      );
      assert.deepEqual(result, {
        outcome: 'transient',
        diagnostic: 'EDEADLINE',
      });
      // The abandoned send is still talking to the stub; cut it off, so it
      // fails, and give its rejection time to surface.
      await stub.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', listener);
    }
  });

  it('uses the overall default when an override is undefined', async () => {
    const { result } = await sendThrough(
      {},
      { timeouts: { ...quick, overall: undefined } },
    );
    assert.deepEqual(result, { outcome: 'accepted' });
  });
});

describe('story 6.2: the production timeouts', () => {
  it('are the spec values, with the overall limit under the 60 s lease', () => {
    assert.deepEqual(
      { ...SMTP_TIMEOUTS },
      {
        dns: 10_000,
        connection: 10_000,
        greeting: 10_000,
        socket: 15_000,
        overall: 45_000,
      },
    );
    assert.ok(SMTP_TIMEOUTS.overall < 60_000);
    assert.ok(SMTP_TIMEOUTS.socket < SMTP_TIMEOUTS.overall);
  });
});

describe('story 6.2: classifying a failure', () => {
  const quoting = (fields: Record<string, unknown>) =>
    Object.assign(
      new Error(`Recipient command failed: 550 <${RECIPIENT}> unknown`),
      {
        name: `SMTPError ${RECIPIENT}`,
        response: `550 <${RECIPIENT}> unknown`,
        rejected: [RECIPIENT],
        rejectedErrors: [{ recipient: RECIPIENT }],
        ...fields,
      },
    );

  it('is permanent only for a 5xx to RCPT TO or DATA', () => {
    for (const [fields, outcome] of [
      [{ responseCode: 550, command: 'RCPT TO' }, 'permanent'],
      [{ responseCode: 552, command: 'DATA' }, 'permanent'],
      [{ responseCode: 599, command: 'RCPT TO' }, 'permanent'],
      [{ responseCode: 450, command: 'RCPT TO' }, 'transient'],
      [{ responseCode: 499, command: 'DATA' }, 'transient'],
      [{ responseCode: 535, command: 'AUTH PLAIN' }, 'transient'],
      [{ responseCode: 550, command: 'MAIL FROM' }, 'transient'],
      [{ responseCode: 554, command: 'CONN' }, 'transient'],
      [{ code: 'EENVELOPE', command: 'API' }, 'transient'],
      [{ code: 'ETIMEDOUT' }, 'transient'],
    ] as const) {
      assert.equal(
        classifySmtpFailure(quoting(fields)).outcome,
        outcome,
        JSON.stringify(fields),
      );
    }
  });

  it('reports the reply code, else a well-formed error code, else EUNKNOWN', () => {
    for (const [error, diagnostic] of [
      [quoting({ responseCode: 550, code: 'EENVELOPE' }), 'SMTP 550'],
      [quoting({ code: 'ESOCKET' }), 'ESOCKET'],
      [quoting({ code: `E${RECIPIENT}` }), 'EUNKNOWN'],
      [quoting({ code: 'esocket' }), 'EUNKNOWN'],
      [quoting({ code: `E${'X'.repeat(40)}` }), 'EUNKNOWN'],
      [quoting({ responseCode: '550' }), 'EUNKNOWN'],
      [quoting({ responseCode: 50 }), 'EUNKNOWN'],
      [new Error(RECIPIENT), 'EUNKNOWN'],
      [RECIPIENT, 'EUNKNOWN'],
      [null, 'EUNKNOWN'],
      [undefined, 'EUNKNOWN'],
    ] as const) {
      const result = classifySmtpFailure(error);
      assert.equal(
        'diagnostic' in result && result.diagnostic,
        diagnostic,
        String(error),
      );
      assertNoRecipient(result);
    }
  });

  it('never throws, even on an error whose fields throw', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(RECIPIENT);
        },
      },
    );
    assert.deepEqual(classifySmtpFailure(hostile), {
      outcome: 'transient',
      diagnostic: 'EUNKNOWN',
    });
  });
});
