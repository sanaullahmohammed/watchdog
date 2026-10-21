import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTrustedOrigin } from '@/server/auth/trusted-origin';

/**
 * Story 4.7: the `Origin` an admin WebSocket upgrade must carry.
 *
 * Needs no database; runs with the unit suite.
 */

const TRUSTED = ['http://localhost:3000'];

describe('isTrustedOrigin', () => {
  it('admits the origin of a trusted URL', () => {
    assert.equal(isTrustedOrigin('http://localhost:3000', TRUSTED), true);
  });

  it('admits an origin given as a URL with a path', () => {
    assert.equal(
      isTrustedOrigin('https://status.example.test', [
        'https://status.example.test/app/',
      ]),
      true,
    );
  });

  it('admits any entry of the list', () => {
    assert.equal(
      isTrustedOrigin('https://admin.example.test', [
        ...TRUSTED,
        'https://admin.example.test',
      ]),
      true,
    );
  });

  it('refuses a different port', () => {
    assert.equal(isTrustedOrigin('http://localhost:3001', TRUSTED), false);
  });

  it('refuses a different scheme', () => {
    assert.equal(isTrustedOrigin('https://localhost:3000', TRUSTED), false);
  });

  it('refuses a different host', () => {
    assert.equal(isTrustedOrigin('http://evil.test', TRUSTED), false);
  });

  it('refuses a missing value', () => {
    assert.equal(isTrustedOrigin(undefined, TRUSTED), false);
    assert.equal(isTrustedOrigin('', TRUSTED), false);
  });

  it('refuses the opaque origin null', () => {
    assert.equal(isTrustedOrigin('null', TRUSTED), false);
    // An opaque trusted entry never matches either.
    assert.equal(isTrustedOrigin('null', ['file:///tmp/x']), false);
  });

  it('refuses a malformed value', () => {
    assert.equal(isTrustedOrigin('not a url', TRUSTED), false);
    assert.equal(isTrustedOrigin('http://localhost:3000/', TRUSTED), false);
    assert.equal(isTrustedOrigin('http://localhost:3000, x', TRUSTED), false);
  });

  it('refuses everything when nothing is trusted', () => {
    assert.equal(isTrustedOrigin('http://localhost:3000', []), false);
    assert.equal(isTrustedOrigin('http://localhost:3000', ['::']), false);
  });
});
