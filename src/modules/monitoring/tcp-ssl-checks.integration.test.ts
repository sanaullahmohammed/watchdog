import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import { createTestCa, type TestCa } from '@/shared/testing/test-certificates';
import {
  type LocalServer,
  startSilentTcpServer,
  startTestEndpoints,
  startTlsServer,
  startUnansweredTcpPort,
  type TestEndpoints,
} from '@/shared/testing/test-endpoints';
import { runSslExpiryCheck } from './checks/ssl-expiry-check';
import { runTcpCheck } from './checks/tcp-check';
import type { HostLookup } from './domain/target-safety';

/**
 * Story 5.5. Everything is local. Validity times sit a day from now because
 * the WSL2 clock steps back by up to 1.4 s (AGENTS.md).
 */

const ALLOWED = parseAllowedCidrs('127.0.0.0/8');
const NONE = parseAllowedCidrs('');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const HOST = 'watchdog.test';
const answering =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses;

let endpoints: TestEndpoints;
let ca: TestCa;
let silent: LocalServer;
const tls: Record<string, LocalServer> = {};
const leaves: Record<string, string> = {};

before(async () => {
  endpoints = await startTestEndpoints();
  silent = await startSilentTcpServer();
  ca = createTestCa();
  const now = Date.now();
  const specs = {
    valid: {
      dns: [HOST],
      ip: ['127.0.0.1'],
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 90 * DAY - 12 * HOUR),
    },
    short: {
      dns: [HOST],
      ip: ['127.0.0.1'],
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 36 * 3_600_000),
    },
    expired: {
      dns: [HOST],
      ip: ['127.0.0.1'],
      notBefore: new Date(now - 3 * DAY),
      notAfter: new Date(now - DAY),
    },
    future: {
      dns: [HOST],
      ip: ['127.0.0.1'],
      notBefore: new Date(now + DAY),
      notAfter: new Date(now + 90 * DAY),
    },
    wrongHost: {
      dns: ['other.test'],
      ip: ['10.9.9.9'],
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 90 * DAY),
    },
  };
  for (const [name, spec] of Object.entries(specs)) {
    const issued = ca.issue(spec);
    leaves[name] = issued.certPem;
    tls[name] = await startTlsServer(issued);
  }
});
after(async () => {
  await Promise.all([
    endpoints.close(),
    silent.close(),
    ...Object.values(tls).map((server) => server.close()),
  ]);
});

const options = (
  allowedRanges = ALLOWED,
  lookup?: HostLookup,
  timeoutSeconds = 5,
) => ({
  timeoutSeconds,
  allowedRanges,
  lookup,
});
const ssl = (opts = options()) => ({ ...opts, ca: ca.caPem });
const fingerprintOf = (pem: string) => {
  const der = new X509Certificate(pem).raw;
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .match(/../g)
    ?.join(':');
};
const NO_CERT = {
  certificateFingerprint: null,
  certificateExpiresAt: null,
  daysRemaining: null,
};
const wait = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('TCP check', () => {
  it('succeeds when the connection is established', async () => {
    endpoints.reset();
    const outcome = await runTcpCheck(`127.0.0.1:${endpoints.port}`, options());
    assert.equal(outcome.status, 'success');
    assert.deepEqual(outcome.metadata, {});
    assert.ok(outcome.latencyMs !== null && outcome.latencyMs >= 0);
    await wait();
    assert.equal(endpoints.connections(), 1);
  });

  it('treats a server that accepts and stays silent as a success', async () => {
    const outcome = await runTcpCheck(`127.0.0.1:${silent.port}`, options());
    assert.equal(outcome.status, 'success');
  });

  it('reports a refused connection', async () => {
    const outcome = await runTcpCheck(
      `127.0.0.1:${endpoints.deadPort}`,
      options(),
    );
    assert.equal(outcome.errorCode, 'connection_refused');
    assert.equal(outcome.latencyMs, null);
  });

  it('times out when the handshake never completes', async () => {
    const unanswered = await startUnansweredTcpPort();
    try {
      const started = performance.now();
      const outcome = await runTcpCheck(
        `127.0.0.1:${unanswered.port}`,
        options(ALLOWED, undefined, 1),
      );
      const elapsed = performance.now() - started;
      assert.equal(outcome.errorCode, 'timeout');
      assert.ok(elapsed >= 900 && elapsed < 3000, `took ${elapsed}`);
    } finally {
      await unanswered.close();
    }
  });

  it('dials a name through the pinned lookup', async () => {
    endpoints.reset();
    const outcome = await runTcpCheck(
      `${HOST}:${endpoints.port}`,
      options(ALLOWED, answering('127.0.0.1')),
    );
    assert.equal(outcome.status, 'success');
    await wait();
    assert.equal(endpoints.connections(), 1);
  });

  it('times out when the lookup never settles', async () => {
    const started = performance.now();
    const outcome = await runTcpCheck(
      `${HOST}:${endpoints.port}`,
      options(ALLOWED, () => new Promise<string[]>(() => {}), 1),
    );
    const elapsed = performance.now() - started;
    assert.equal(outcome.errorCode, 'timeout');
    assert.ok(elapsed >= 900 && elapsed < 3000, `took ${elapsed}`);
  });

  it('refuses a target the guard refuses before any socket opens', async () => {
    endpoints.reset();
    const empty = await runTcpCheck(
      `127.0.0.1:${endpoints.port}`,
      options(NONE),
    );
    assert.equal(empty.errorCode, 'target_refused');
    const named = await runTcpCheck(
      `monitor.example.test:${endpoints.port}`,
      options(NONE, answering('127.0.0.1')),
    );
    assert.equal(named.errorCode, 'target_refused');
    assert.ok(!named.errorMessage?.includes('127.0.0.1'));
    await wait();
    assert.equal(endpoints.connections(), 0);
  });

  it('refuses a malformed target', async () => {
    const outcome = await runTcpCheck('no-port', options());
    assert.equal(outcome.errorCode, 'target_refused');
  });
});

describe('SSL-expiry check', () => {
  it('succeeds on a valid certificate by IP and by name', async () => {
    const expected = fingerprintOf(leaves.valid as string);
    const notAfter = new X509Certificate(leaves.valid as string).validTo;
    for (const [target, lookup] of [
      [`127.0.0.1:${tls.valid?.port}`, undefined],
      [`${HOST}:${tls.valid?.port}`, answering('127.0.0.1')],
    ] as const) {
      const outcome = await runSslExpiryCheck(
        target,
        ssl(options(ALLOWED, lookup)),
      );
      assert.equal(outcome.status, 'success', outcome.errorMessage ?? '');
      assert.equal(outcome.metadata.certificateFingerprint, expected);
      assert.equal(
        outcome.metadata.certificateExpiresAt,
        new Date(notAfter).toISOString(),
      );
      assert.equal(outcome.metadata.daysRemaining, 89);
      assert.ok(outcome.latencyMs !== null);
    }
    await wait();
    assert.deepEqual(tls.valid?.servernames, [false, HOST]);
  });

  it('succeeds with 1 day remaining on a 36 hour certificate', async () => {
    const outcome = await runSslExpiryCheck(
      `127.0.0.1:${tls.short?.port}`,
      ssl(),
    );
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.metadata.daysRemaining, 1);
  });

  const invalid = [
    ['expired', 'certificate_expired'],
    ['future', 'certificate_not_yet_valid'],
    ['wrongHost', 'certificate_hostname_mismatch'],
  ] as const;
  for (const [name, code] of invalid) {
    it(`fails ${name} with ${code} and keeps the metadata`, async () => {
      const outcome = await runSslExpiryCheck(
        `127.0.0.1:${tls[name]?.port}`,
        ssl(),
      );
      assert.equal(outcome.errorCode, code);
      assert.equal(
        outcome.metadata.certificateFingerprint,
        fingerprintOf(leaves[name] as string),
      );
      assert.ok(outcome.metadata.certificateExpiresAt);
      assert.equal(typeof outcome.metadata.daysRemaining, 'number');
      assert.ok(outcome.latencyMs !== null);
    });
  }

  it('reports a hostname mismatch by name', async () => {
    const outcome = await runSslExpiryCheck(
      `${HOST}:${tls.wrongHost?.port}`,
      ssl(options(ALLOWED, answering('127.0.0.1'))),
    );
    assert.equal(outcome.errorCode, 'certificate_hostname_mismatch');
  });

  it('reports an expired certificate with a negative daysRemaining', async () => {
    const outcome = await runSslExpiryCheck(
      `127.0.0.1:${tls.expired?.port}`,
      ssl(),
    );
    assert.ok((outcome.metadata.daysRemaining ?? 0) < 0);
  });

  it('fails an untrusted certificate', async () => {
    const port = new URL(endpoints.httpsOrigin).port;
    const outcome = await runSslExpiryCheck(`127.0.0.1:${port}`, options());
    assert.equal(outcome.errorCode, 'certificate_untrusted');
    assert.match(outcome.errorMessage ?? '', /SELF_SIGNED/);
    assert.ok(outcome.metadata.certificateFingerprint);
    assert.ok(outcome.metadata.certificateExpiresAt);
    assert.equal(typeof outcome.metadata.daysRemaining, 'number');
    assert.ok(outcome.latencyMs !== null);
  });

  it('has no certificate metadata when none was retrieved', async () => {
    const refused = await runSslExpiryCheck(
      `127.0.0.1:${endpoints.deadPort}`,
      ssl(),
    );
    assert.equal(refused.errorCode, 'connection_refused');
    assert.deepEqual(refused.metadata, NO_CERT);

    const started = performance.now();
    const timedOut = await runSslExpiryCheck(
      `127.0.0.1:${silent.port}`,
      ssl(options(ALLOWED, undefined, 1)),
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 3000, `took ${elapsed}`);
    assert.equal(timedOut.errorCode, 'timeout');
    assert.deepEqual(timedOut.metadata, NO_CERT);

    const plain = await runSslExpiryCheck(`127.0.0.1:${endpoints.port}`, ssl());
    assert.equal(plain.errorCode, 'tls_error');
    assert.deepEqual(plain.metadata, NO_CERT);

    const dns = await runSslExpiryCheck(
      `${HOST}:${tls.valid?.port}`,
      ssl(
        options(ALLOWED, async () => {
          throw new Error('nxdomain');
        }),
      ),
    );
    assert.equal(dns.errorCode, 'dns_failure');
    assert.deepEqual(dns.metadata, NO_CERT);
  });

  it('opens no connection when the guard refuses', async () => {
    const server = await startTlsServer(
      ca.issue({
        dns: [HOST],
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + DAY),
      }),
    );
    try {
      const outcome = await runSslExpiryCheck(
        `127.0.0.1:${server.port}`,
        ssl(options(NONE)),
      );
      assert.equal(outcome.errorCode, 'target_refused');
      assert.deepEqual(outcome.metadata, NO_CERT);
      await wait();
      assert.equal(server.connections(), 0);
    } finally {
      await server.close();
    }
  });
});
