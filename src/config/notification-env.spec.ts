import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import {
  notificationEnvProperties,
  resolveEmailSettings,
} from './notification-env';

const schema = Type.Object(notificationEnvProperties);

const defaults = () =>
  Value.Default(schema, {}) as {
    SMTP_HOST: string;
    SMTP_PORT: number;
    SMTP_FROM: string;
    SMTP_SECURE: boolean;
  };

const resolve = (
  overrides: Record<string, string | undefined> = {},
  betterAuthUrl = 'http://localhost:3000',
) =>
  resolveEmailSettings({
    ...defaults(),
    BETTER_AUTH_URL: betterAuthUrl,
    ...overrides,
  });

describe('story 6.2: the SMTP settings', () => {
  it('defaults to Mailpit on localhost:1025 with no login', () => {
    const value = defaults();
    assert.equal(value.SMTP_HOST, 'localhost');
    assert.equal(value.SMTP_PORT, 1025);
    assert.equal(value.SMTP_FROM, 'WatchDog <watchdog@localhost>');
    assert.equal(value.SMTP_SECURE, false);
    assert.equal(Value.Check(schema, value), true);

    assert.deepEqual(resolve().email, {
      host: 'localhost',
      port: 1025,
      secure: false,
      from: 'WatchDog <watchdog@localhost>',
    });
  });

  it('refuses a port outside 1 to 65535, or a fraction', () => {
    for (const bad of [0, 65_536, 25.5]) {
      assert.equal(
        Value.Check(schema, { ...defaults(), SMTP_PORT: bad }),
        false,
        String(bad),
      );
    }
    for (const ok of [1, 65_535]) {
      assert.equal(Value.Check(schema, { ...defaults(), SMTP_PORT: ok }), true);
    }
  });

  it('uses a login only when both halves are set', () => {
    assert.deepEqual(
      resolve({ SMTP_USER: 'mailer', SMTP_PASSWORD: 's3cret' }).email.auth,
      { user: 'mailer', pass: 's3cret' },
    );
  });

  it('refuses half a login, naming both variables and quoting neither', () => {
    for (const half of [
      { SMTP_USER: 'mailer' },
      { SMTP_PASSWORD: 's3cret' },
      { SMTP_USER: '', SMTP_PASSWORD: 's3cret' },
      { SMTP_USER: 'mailer', SMTP_PASSWORD: '' },
    ]) {
      assert.throws(
        () => resolve(half),
        (error: Error) =>
          /SMTP_USER/.test(error.message) &&
          /SMTP_PASSWORD/.test(error.message) &&
          !/mailer|s3cret/.test(error.message),
        JSON.stringify(half),
      );
    }
  });

  it('treats an empty SMTP_USER and SMTP_PASSWORD as unset', () => {
    const { email } = resolve({ SMTP_USER: '', SMTP_PASSWORD: '' });
    assert.equal(email.auth, undefined);
    assert.equal('auth' in email, false);
  });
});

describe('story 6.2: SMTP_FROM', () => {
  it('accepts one address, with or without a display name', () => {
    for (const ok of [
      '"WatchDog" <a@b.c>',
      'WatchDog <watchdog@localhost>',
      'watchdog@localhost',
    ]) {
      assert.equal(resolve({ SMTP_FROM: ok }).email.from, ok, ok);
    }
  });

  it('refuses anything but exactly one address, naming the variable and quoting nothing', () => {
    for (const bad of ['WatchDog', 'watchdog@', '@localhost', 'a@b, c@d']) {
      assert.throws(
        () => resolve({ SMTP_FROM: bad }),
        (error: Error) =>
          /SMTP_FROM/.test(error.message) && !error.message.includes(bad),
        bad,
      );
    }
  });
});

describe('story 6.2: PUBLIC_BASE_URL', () => {
  it("defaults to BETTER_AUTH_URL's origin", () => {
    assert.equal(resolve().publicBaseUrl, 'http://localhost:3000');
    assert.equal(
      resolve({}, 'https://watchdog.example.com/api/auth?x=1').publicBaseUrl,
      'https://watchdog.example.com',
    );
  });

  it('treats an empty string as unset', () => {
    assert.equal(
      resolve({ PUBLIC_BASE_URL: '' }, 'https://auth.example.com/')
        .publicBaseUrl,
      'https://auth.example.com',
    );
  });

  it('accepts a bare http(s) origin, normalised to its lowercase origin with no default port', () => {
    for (const [given, origin] of [
      ['https://status.example.com', 'https://status.example.com'],
      ['https://status.example.com/', 'https://status.example.com'],
      ['http://localhost:3000', 'http://localhost:3000'],
      ['https://Status.Example.com', 'https://status.example.com'],
      ['https://status.example.com:443', 'https://status.example.com'],
    ]) {
      assert.equal(resolve({ PUBLIC_BASE_URL: given }).publicBaseUrl, origin);
    }
  });

  it('refuses anything that is not a bare http(s) origin, naming the variable', () => {
    for (const bad of [
      'https://status.example.com/status',
      'https://status.example.com/?q=1',
      'https://status.example.com/#top',
      'https://user:pass@status.example.com',
      'ftp://status.example.com',
      'status.example.com',
      'not a url',
    ]) {
      assert.throws(
        () => resolve({ PUBLIC_BASE_URL: bad }),
        (error: Error) =>
          /PUBLIC_BASE_URL/.test(error.message) && !error.message.includes(bad),
        bad,
      );
    }
  });

  it('refuses a BETTER_AUTH_URL it cannot take an origin from when unset', () => {
    assert.throws(
      () => resolve({}, 'not a url'),
      /PUBLIC_BASE_URL.*BETTER_AUTH_URL/,
    );
  });
});
