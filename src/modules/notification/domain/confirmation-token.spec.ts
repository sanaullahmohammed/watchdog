import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { generateConfirmationToken } from './confirmation-token';

describe('generateConfirmationToken', () => {
  it('is 32 random bytes in base64url, hashed with SHA-256 hex', () => {
    const { token, hash } = generateConfirmationToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, createHash('sha256').update(token).digest('hex'));
  });

  it('gives a different token each time', () => {
    assert.notEqual(
      generateConfirmationToken().token,
      generateConfirmationToken().token,
    );
  });
});
