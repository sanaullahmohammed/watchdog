import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildConfirmationEmail } from './confirmation-email';

const input = {
  to: 'ann@x.test',
  orgName: 'Acme',
  orgSlug: 'acme',
  token: 'tok_en-1',
  ttlHours: 24,
  publicBaseUrl: 'https://status.example.test',
};

describe('buildConfirmationEmail', () => {
  it('builds the subject, the link and plain text only', () => {
    const message = buildConfirmationEmail(input);
    assert.equal(message.to, 'ann@x.test');
    assert.equal(
      message.subject,
      'Confirm your subscription to Acme status updates',
    );
    assert.ok(
      message.text.includes(
        'https://status.example.test/status/acme/subscribers/confirm?token=tok_en-1',
      ),
    );
    assert.ok(message.text.includes('The link works for 24 hours.'));
    assert.ok(
      message.text.includes(
        'If you did not ask for this, ignore this email; nothing more will be sent.',
      ),
    );
    assert.equal(message.headers, undefined);
    assert.ok(!('html' in message));
  });

  it('says "1 hour" in the singular', () => {
    const { text } = buildConfirmationEmail({ ...input, ttlHours: 1 });
    assert.ok(text.includes('The link works for 1 hour.'));
  });
});
