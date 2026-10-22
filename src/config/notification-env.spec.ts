import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import {
  assertRetryDelays,
  assertSubscribeLimits,
  notificationEnvProperties,
  resolveEmailSettings,
} from './notification-env';

const schema = Type.Object(notificationEnvProperties);

const SECRET = 'a-link-secret-of-at-least-32-characters';

const defaults = () =>
  Value.Default(schema, { NOTIFICATION_LINK_SECRET: SECRET }) as {
    NOTIFICATION_LINK_SECRET: string;
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

describe('story 6.4: NOTIFICATION_LINK_SECRET', () => {
  it('is required', () => {
    assert.equal(Value.Check(schema, Value.Default(schema, {})), false);
  });

  it('must be at least 32 characters', () => {
    assert.equal(
      Value.Check(schema, { ...defaults(), NOTIFICATION_LINK_SECRET: 'short' }),
      false,
    );
    assert.equal(Value.Check(schema, defaults()), true);
  });
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

describe('story 6.3: the subscribe settings', () => {
  it('defaults to 5 per hour, a 24 hour token and a 10 minute resend window', () => {
    const value = Value.Default(schema, {
      NOTIFICATION_LINK_SECRET: SECRET,
    }) as Record<string, number>;
    assert.equal(value.SUBSCRIBE_RATE_LIMIT_MAX, 5);
    assert.equal(value.SUBSCRIBE_RATE_LIMIT_WINDOW_MS, 3_600_000);
    assert.equal(value.SUBSCRIBER_CONFIRMATION_TTL_HOURS, 24);
    assert.equal(value.SUBSCRIBER_CONFIRMATION_RESEND_SECONDS, 600);
    assert.equal(Value.Check(schema, value), true);
  });

  it('refuses values below each minimum', () => {
    const base = Value.Default(schema, {
      NOTIFICATION_LINK_SECRET: SECRET,
    }) as Record<string, unknown>;
    for (const [name, bad] of [
      ['SUBSCRIBE_RATE_LIMIT_MAX', 0],
      ['SUBSCRIBE_RATE_LIMIT_WINDOW_MS', 999],
      ['SUBSCRIBER_CONFIRMATION_TTL_HOURS', 0],
      ['SUBSCRIBER_CONFIRMATION_RESEND_SECONDS', -1],
    ] as const) {
      assert.equal(Value.Check(schema, { ...base, [name]: bad }), false, name);
    }
    assert.equal(
      Value.Check(schema, {
        ...base,
        SUBSCRIBER_CONFIRMATION_RESEND_SECONDS: 0,
      }),
      true,
    );
  });

  it('refuses a fraction and a value over each maximum', () => {
    const base = Value.Default(schema, {
      NOTIFICATION_LINK_SECRET: SECRET,
    }) as Record<string, unknown>;
    for (const [name, bad] of [
      ['SUBSCRIBE_RATE_LIMIT_MAX', 1.5],
      ['SUBSCRIBE_RATE_LIMIT_WINDOW_MS', 1000.5],
      ['SUBSCRIBER_CONFIRMATION_TTL_HOURS', 1.5],
      ['SUBSCRIBER_CONFIRMATION_TTL_HOURS', 8761],
      ['SUBSCRIBER_CONFIRMATION_RESEND_SECONDS', 0.5],
      ['SUBSCRIBER_CONFIRMATION_RESEND_SECONDS', 86_401],
    ] as const) {
      assert.equal(
        Value.Check(schema, { ...base, [name]: bad }),
        false,
        `${name} ${bad}`,
      );
    }
  });

  const limits = (overrides: Record<string, number> = {}) => ({
    SUBSCRIBE_RATE_LIMIT_MAX: 5,
    SUBSCRIBE_RATE_LIMIT_WINDOW_MS: 3_600_000,
    PUBLIC_RATE_LIMIT_MAX: 120,
    PUBLIC_RATE_LIMIT_WINDOW_MS: 60_000,
    ...overrides,
  });

  it('accepts a limit no looser than the public one', () => {
    assert.doesNotThrow(() => assertSubscribeLimits(limits()));
    assert.doesNotThrow(() =>
      assertSubscribeLimits(
        limits({
          SUBSCRIBE_RATE_LIMIT_MAX: 120,
          SUBSCRIBE_RATE_LIMIT_WINDOW_MS: 60_000,
        }),
      ),
    );
  });

  it('refuses a larger max, naming both variables', () => {
    assert.throws(
      () => assertSubscribeLimits(limits({ SUBSCRIBE_RATE_LIMIT_MAX: 121 })),
      /SUBSCRIBE_RATE_LIMIT_MAX.*PUBLIC_RATE_LIMIT_MAX/,
    );
  });

  it('refuses a shorter window, naming both variables', () => {
    assert.throws(
      () =>
        assertSubscribeLimits(
          limits({ SUBSCRIBE_RATE_LIMIT_WINDOW_MS: 59_999 }),
        ),
      /SUBSCRIBE_RATE_LIMIT_WINDOW_MS.*PUBLIC_RATE_LIMIT_WINDOW_MS/,
    );
  });
});

describe('story 6.6: the notification pass settings', () => {
  const base = () =>
    Value.Default(schema, {
      NOTIFICATION_LINK_SECRET: SECRET,
    }) as Record<string, number>;

  it('defaults to a 30 s pass that re-reads 300 s behind its cursor', () => {
    const value = base();
    assert.equal(value.NOTIFICATION_PASS_INTERVAL_MS, 30_000);
    assert.equal(value.NOTIFICATION_CURSOR_OVERLAP_SECONDS, 300);
    assert.equal(Value.Check(schema, value), true);
  });

  it('accepts each bound', () => {
    for (const [name, ok] of [
      ['NOTIFICATION_PASS_INTERVAL_MS', 1_000],
      ['NOTIFICATION_PASS_INTERVAL_MS', 2_147_483_647],
      ['NOTIFICATION_CURSOR_OVERLAP_SECONDS', 1],
      ['NOTIFICATION_CURSOR_OVERLAP_SECONDS', 86_400],
    ] as const) {
      assert.equal(
        Value.Check(schema, { ...base(), [name]: ok }),
        true,
        `${name} ${ok}`,
      );
    }
  });

  it('refuses a value outside the bounds, and a fraction', () => {
    for (const [name, bad] of [
      ['NOTIFICATION_PASS_INTERVAL_MS', 999],
      ['NOTIFICATION_PASS_INTERVAL_MS', 2_147_483_648],
      ['NOTIFICATION_PASS_INTERVAL_MS', 1000.5],
      ['NOTIFICATION_CURSOR_OVERLAP_SECONDS', 0],
      ['NOTIFICATION_CURSOR_OVERLAP_SECONDS', 86_401],
      ['NOTIFICATION_CURSOR_OVERLAP_SECONDS', 1.5],
    ] as const) {
      assert.equal(
        Value.Check(schema, { ...base(), [name]: bad }),
        false,
        `${name} ${bad}`,
      );
    }
  });
});

describe('story 6.7: the retry settings', () => {
  const base = () =>
    Value.Default(schema, {
      NOTIFICATION_LINK_SECRET: SECRET,
    }) as Record<string, number>;

  it('defaults to 60 s doubling to 3600 s, 8 attempts', () => {
    const value = base();
    assert.equal(value.NOTIFICATION_RETRY_BASE_SECONDS, 60);
    assert.equal(value.NOTIFICATION_RETRY_MAX_DELAY_SECONDS, 3_600);
    assert.equal(value.NOTIFICATION_MAX_ATTEMPTS, 8);
    assert.equal(Value.Check(schema, value), true);
  });

  it('accepts each bound and refuses outside them', () => {
    for (const [name, value, ok] of [
      ['NOTIFICATION_RETRY_BASE_SECONDS', 60, true],
      ['NOTIFICATION_RETRY_BASE_SECONDS', 86_400, true],
      ['NOTIFICATION_RETRY_BASE_SECONDS', 59, false],
      ['NOTIFICATION_RETRY_BASE_SECONDS', 86_401, false],
      ['NOTIFICATION_RETRY_MAX_DELAY_SECONDS', 60, true],
      ['NOTIFICATION_RETRY_MAX_DELAY_SECONDS', 59, false],
      ['NOTIFICATION_RETRY_MAX_DELAY_SECONDS', 604_800, true],
      ['NOTIFICATION_RETRY_MAX_DELAY_SECONDS', 604_801, false],
      ['NOTIFICATION_MAX_ATTEMPTS', 1, true],
      ['NOTIFICATION_MAX_ATTEMPTS', 100, true],
      ['NOTIFICATION_MAX_ATTEMPTS', 0, false],
      ['NOTIFICATION_MAX_ATTEMPTS', 101, false],
    ] as const) {
      assert.equal(
        Value.Check(schema, { ...base(), [name]: value }),
        ok,
        `${name} ${value}`,
      );
    }
  });

  it('refuses a maximum delay below the base, naming both', () => {
    assert.throws(
      () =>
        assertRetryDelays({
          NOTIFICATION_RETRY_BASE_SECONDS: 120,
          NOTIFICATION_RETRY_MAX_DELAY_SECONDS: 119,
        }),
      /NOTIFICATION_RETRY_MAX_DELAY_SECONDS.*NOTIFICATION_RETRY_BASE_SECONDS/,
    );
    assert.doesNotThrow(() =>
      assertRetryDelays({
        NOTIFICATION_RETRY_BASE_SECONDS: 120,
        NOTIFICATION_RETRY_MAX_DELAY_SECONDS: 120,
      }),
    );
  });
});
