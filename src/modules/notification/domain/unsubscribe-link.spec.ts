import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  signUnsubscribe,
  unsubscribeLink,
  verifyUnsubscribe,
} from './unsubscribe-link';

const SECRET = 'a-link-secret-of-at-least-32-characters';
const ORG = 'org_1234567890123456789012345678';
const SUB = '3f0c1c1e-8a52-4a53-9d0e-5b3c6e3e9a11';

describe('story 6.4: the unsubscribe link', () => {
  it('round-trips and signs 43 base64url characters', () => {
    const signature = signUnsubscribe(SECRET, ORG, SUB);
    assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(verifyUnsubscribe(SECRET, ORG, SUB, signature), true);
  });

  it('signs the labelled message, so another purpose cannot reuse it', () => {
    const labelled = createHmac('sha256', SECRET)
      .update(`unsubscribe\n${ORG}\n${SUB}`)
      .digest('base64url');
    const unlabelled = createHmac('sha256', SECRET)
      .update(`${ORG}\n${SUB}`)
      .digest('base64url');
    assert.equal(signUnsubscribe(SECRET, ORG, SUB), labelled);
    assert.equal(verifyUnsubscribe(SECRET, ORG, SUB, unlabelled), false);
  });

  it('refuses a wrong secret, organization or subscriber', () => {
    const signature = signUnsubscribe(SECRET, ORG, SUB);
    assert.equal(verifyUnsubscribe(`${SECRET}x`, ORG, SUB, signature), false);
    assert.equal(verifyUnsubscribe(SECRET, `${ORG}x`, SUB, signature), false);
    assert.equal(
      verifyUnsubscribe(SECRET, ORG, SUB.replace('3f', '4f'), signature),
      false,
    );
  });

  it('refuses a signature of the wrong length or alphabet without throwing', () => {
    const signature = signUnsubscribe(SECRET, ORG, SUB);
    for (const bad of [
      '',
      signature.slice(1),
      `${signature}A`,
      '!'.repeat(43),
      'é'.repeat(43),
      '\u0000'.repeat(43),
    ]) {
      assert.equal(verifyUnsubscribe(SECRET, ORG, SUB, bad), false);
    }
  });

  it('refuses the alternative spelling of the last character', () => {
    const signature = signUnsubscribe(SECRET, ORG, SUB);
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = signature.at(-1) as string;
    // The last character carries 4 bits; others share its decoded bytes.
    const sibling = alphabet
      .split('')
      .find(
        (c) =>
          c !== last &&
          Buffer.from(signature.slice(0, -1) + c, 'base64url').equals(
            Buffer.from(signature, 'base64url'),
          ),
      );
    assert.ok(sibling);
    assert.equal(
      verifyUnsubscribe(SECRET, ORG, SUB, signature.slice(0, -1) + sibling),
      false,
    );
  });

  it('builds the exact link shape', () => {
    const signature = signUnsubscribe(SECRET, ORG, SUB);
    assert.equal(
      unsubscribeLink('https://status.example.com', 'acme', ORG, SUB, SECRET),
      `https://status.example.com/status/acme/subscribers/unsubscribe?subscriber=${SUB}&signature=${signature}`,
    );
  });
});
