import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { parseFromAddress } from '@/config/notification-env';
import type { EmailSender } from '@/modules/notification/domain/email-sender.port';
import { buildApp } from '@/server/build-app';
import { messagesTo, uniqueRecipient } from '@/shared/testing/mailpit';

/**
 * Story 6.2, "Delivered": the container's sender, built from `env.email`,
 * reaches Mailpit. The transport is never stubbed (decision D15).
 */

let app: FastifyInstance;

describe('Story 6.2: send email through SMTP', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('delivers a plain-text message with its extra header to Mailpit', async () => {
    const to = uniqueRecipient('smtp-sender');
    const sender = app.diContainer.resolve('emailSender') as EmailSender;
    const text = 'The API is degraded.\nWe are investigating.';

    const result = await sender.send({
      to,
      subject: 'Acme status: investigating',
      text,
      headers: { 'List-Unsubscribe': '<https://status.example.test/u/1>' },
    });
    assert.deepEqual(result, { outcome: 'accepted' });

    // Mailpit stores a message before it answers 250, but a slow one gets
    // up to 2 s.
    const messages = await messagesTo(to, { atLeast: 1 });
    assert.equal(messages.length, 1);
    const [message] = messages;

    // Compared parsed, so a quoted display name in SMTP_FROM still matches.
    assert.deepEqual(
      { name: message.From.Name, address: message.From.Address },
      parseFromAddress(env.email.from),
    );
    assert.deepEqual(
      message.To.map((recipient) => recipient.Address),
      [to],
    );
    assert.equal(message.Subject, 'Acme status: investigating');
    // SMTP carries lines as CRLF, and Mailpit keeps the trailing newline.
    assert.equal(message.Text.replace(/\r\n/g, '\n').trim(), text);
    assert.equal(message.HTML, '');
    assert.deepEqual(message.Headers['List-Unsubscribe'], [
      '<https://status.example.test/u/1>',
    ]);
    assert.match(message.Headers['Content-Type']?.[0] ?? '', /^text\/plain/);
  });
});
