import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import {
  startTestEndpoints,
  type TestEndpoints,
} from '@/shared/testing/test-endpoints';
import { runHttpCheck } from './checks/http-check';
import { runKeywordCheck } from './checks/keyword-check';
import { KEYWORD_BODY_CAP_BYTES } from './domain/monitor-limits';
import { assertTargetAllowed, type HostLookup } from './domain/target-safety';

/**
 * Story 5.4. The test servers listen on 127.0.0.1, so they are reachable only
 * because the configuration under test allows 127.0.0.0/8; with the default
 * empty list the same checks are refused and the server sees nothing.
 */

const ALLOWED = parseAllowedCidrs('127.0.0.0/8');
const NONE = parseAllowedCidrs('');
const answering =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses;

let server: TestEndpoints;
before(async () => {
  server = await startTestEndpoints();
});
after(async () => {
  await server.close();
});

const options = (allowedRanges = ALLOWED, lookup?: HostLookup) => ({
  timeoutSeconds: 5,
  allowedRanges,
  lookup,
});

describe('HTTP check', () => {
  it('succeeds on a 2xx and sets checkedAt and latency', async () => {
    server.reset();
    const outcome = await runHttpCheck(`${server.origin}/ok`, options());
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.errorCode, null);
    assert.equal(outcome.errorMessage, null);
    assert.equal(outcome.metadata.statusCode, 200);
    assert.equal(outcome.metadata.redirects, 0);
    assert.ok(outcome.latencyMs !== null && outcome.latencyMs >= 0);
    assert.equal(server.headers[0]?.['accept-encoding'], 'identity');
    assert.equal(server.headers[0]?.['user-agent'], 'WatchDog-Monitor/1.0');
  });

  it('stamps checkedAt when the attempt starts, not when it ends', async () => {
    // Compared with the moment the lookup starts, microseconds after the
    // stamp, rather than with the end, because this machine's clock steps
    // back by more than a second (AGENTS.md).
    let lookupAt = 0;
    const lookup: HostLookup = async () => {
      lookupAt = Date.now();
      return ['127.0.0.1'];
    };
    const outcome = await runHttpCheck(
      `http://monitor.example.test:${server.port}/silent`,
      { ...options(ALLOWED, lookup), timeoutSeconds: 1 },
    );
    assert.equal(outcome.errorCode, 'timeout');
    assert.ok(outcome.checkedAt.getTime() <= lookupAt);
  });

  it('opens a connection per check and per hop', async () => {
    server.reset();
    await runHttpCheck(`${server.origin}/ok`, options());
    await runHttpCheck(`${server.origin}/ok`, options());
    assert.equal(server.connections(), 2);
    server.reset();
    await runHttpCheck(`${server.origin}/chain/3`, options());
    assert.equal(server.connections(), 4);
  });

  it('verifies certificates: a self-signed one is tls_error', async () => {
    const outcome = await runHttpCheck(`${server.httpsOrigin}/`, options());
    assert.equal(outcome.errorCode, 'tls_error');
  });

  it('fails a 5xx as http_status', async () => {
    const outcome = await runHttpCheck(`${server.origin}/error`, options());
    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.errorCode, 'http_status');
    assert.equal(outcome.metadata.statusCode, 503);
  });

  it('fails a refused port as connection_refused', async () => {
    const outcome = await runHttpCheck(
      `http://127.0.0.1:${server.deadPort}/`,
      options(),
    );
    assert.equal(outcome.errorCode, 'connection_refused');
    assert.equal(outcome.metadata.statusCode, null);
    assert.equal(outcome.latencyMs, null);
    const named = await runHttpCheck(
      `http://monitor.example.test:${server.deadPort}/`,
      options(ALLOWED, answering('127.0.0.1')),
    );
    assert.equal(named.errorCode, 'connection_refused');
    assert.ok(named.errorMessage?.includes('monitor.example.test'));
    assert.ok(!named.errorMessage?.includes('127.0.0.1'));
  });

  it('fails a silent endpoint as timeout within the timeout', async () => {
    const started = performance.now();
    const outcome = await runHttpCheck(`${server.origin}/silent`, {
      ...options(),
      timeoutSeconds: 1,
    });
    const elapsed = performance.now() - started;
    assert.equal(outcome.errorCode, 'timeout');
    assert.ok(elapsed >= 900 && elapsed < 2_500, `took ${elapsed} ms`);
  });

  it('fails TLS against a plain server as tls_error', async () => {
    const outcome = await runHttpCheck(
      `https://127.0.0.1:${server.port}/ok`,
      options(),
    );
    assert.equal(outcome.errorCode, 'tls_error');
  });

  it('fails a lookup that rejects, or finds nothing, as dns_failure', async () => {
    for (const lookup of [
      async () => {
        throw new Error('nxdomain');
      },
      answering(),
    ]) {
      const outcome = await runHttpCheck(
        `http://monitor.example.test:${server.port}/ok`,
        options(ALLOWED, lookup),
      );
      assert.equal(outcome.errorCode, 'dns_failure');
    }
  });

  it('fails a lookup that never answers as timeout, and aborts it', async () => {
    let aborted = false;
    const lookup: HostLookup = (_host, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      });
    const started = performance.now();
    const outcome = await runHttpCheck(
      `http://monitor.example.test:${server.port}/ok`,
      { ...options(ALLOWED, lookup), timeoutSeconds: 1 },
    );
    assert.equal(outcome.errorCode, 'timeout');
    assert.ok(performance.now() - started < 2_500);
    assert.equal(aborted, true);
  });

  it('dials the address it classified, whatever the name', async () => {
    server.reset();
    const outcome = await runHttpCheck(
      `http://monitor.example.test:${server.port}/ok`,
      options(ALLOWED, answering('127.0.0.1')),
    );
    assert.equal(outcome.status, 'success');
    assert.equal(server.requests.length, 1);
  });
});

describe('Refused targets', () => {
  const literals = [
    (p: number) => `http://127.0.0.1:${p}/ok`,
    (p: number) => `http://[::ffff:127.0.0.1]:${p}/ok`,
    (p: number) => `http://0x7f.1:${p}/ok`,
    (p: number) => `http://localhost:${p}/ok`,
    (p: number) => `http://localhost.:${p}/ok`,
    (p: number) => `http://[::1]:${p}/ok`,
  ];
  for (const make of literals) {
    it(`refuses ${make(1)} with the default empty list`, async () => {
      server.reset();
      const outcome = await runHttpCheck(make(server.port), options(NONE));
      assert.equal(outcome.status, 'failure');
      assert.equal(outcome.errorCode, 'target_refused');
      assert.equal(server.connections(), 0);
      assert.equal(server.requests.length, 0);
    });
  }

  const resolved = [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::ffff:127.0.0.1',
  ];
  for (const address of resolved) {
    it(`refuses a name that resolves to ${address}`, async () => {
      server.reset();
      const outcome = await runHttpCheck(
        `http://monitor.example.test:${server.port}/ok`,
        options(NONE, answering(address)),
      );
      assert.equal(outcome.errorCode, 'target_refused');
      assert.equal(server.connections(), 0);
      assert.ok(!outcome.errorMessage?.includes(address));
    });
  }

  it('refuses a name when any one address is blocked', async () => {
    server.reset();
    const outcome = await runHttpCheck(
      `http://monitor.example.test:${server.port}/ok`,
      options(NONE, answering('93.184.216.34', '10.0.0.1')),
    );
    assert.equal(outcome.errorCode, 'target_refused');
    assert.equal(server.connections(), 0);
  });

  it('refuses the keyword check the same way', async () => {
    server.reset();
    const outcome = await runKeywordCheck(
      `${server.origin}/ok`,
      'ok',
      options(NONE),
    );
    assert.equal(outcome.errorCode, 'target_refused');
    assert.equal(server.connections(), 0);
  });

  it('refuses a host that resolved to a public address when configured', async () => {
    const target = `http://monitor.example.test:${server.port}/ok`;
    await assertTargetAllowed('http', target, {
      allowedRanges: NONE,
      lookup: answering('93.184.216.34'),
    });
    server.reset();
    const outcome = await runHttpCheck(
      target,
      options(NONE, answering('127.0.0.1')),
    );
    assert.equal(outcome.errorCode, 'target_refused');
    assert.equal(server.connections(), 0);
  });
});

describe('Redirects', () => {
  it('follows a chain and counts the hops', async () => {
    const outcome = await runHttpCheck(`${server.origin}/chain/3`, options());
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.metadata.redirects, 3);
    assert.equal(outcome.metadata.statusCode, 200);
  });

  it('refuses a hop to a blocked address, naming the redirect', async () => {
    server.reset();
    const hop = `http://127.0.0.2:${server.port}/ok`;
    const outcome = await runHttpCheck(
      `${server.origin}/redirect-to?url=${encodeURIComponent(hop)}`,
      options(parseAllowedCidrs('127.0.0.1/32')),
    );
    assert.equal(outcome.errorCode, 'target_refused');
    assert.match(outcome.errorMessage ?? '', /redirect/);
    assert.equal(server.requests.length, 1);
    assert.equal(outcome.metadata.statusCode, 302);
  });

  it('refuses a disguised hop', async () => {
    server.reset();
    const hop = `http://0x7f.0.0.2:${server.port}/ok`;
    const outcome = await runHttpCheck(
      `${server.origin}/redirect-to?url=${encodeURIComponent(hop)}`,
      options(parseAllowedCidrs('127.0.0.1/32')),
    );
    assert.equal(outcome.errorCode, 'target_refused');
    assert.match(outcome.errorMessage ?? '', /redirect/);
    assert.equal(server.requests.length, 1);
  });

  it('stops at the sixth redirect', async () => {
    server.reset();
    const outcome = await runHttpCheck(`${server.origin}/chain/6`, options());
    assert.equal(outcome.errorCode, 'too_many_redirects');
    assert.equal(outcome.metadata.redirects, 5);
    assert.deepEqual(server.requests, [
      '/chain/6',
      '/chain/5',
      '/chain/4',
      '/chain/3',
      '/chain/2',
      '/chain/1',
    ]);
  });

  it('bounds a chain of slow hops by one deadline', async () => {
    const started = performance.now();
    const outcome = await runHttpCheck(
      `${server.origin}/slow-chain/4?delay=400`,
      { ...options(), timeoutSeconds: 1 },
    );
    const elapsed = performance.now() - started;
    assert.equal(outcome.errorCode, 'timeout');
    assert.ok(elapsed >= 900 && elapsed < 2_000, `took ${elapsed} ms`);
  });

  for (const [label, location] of [
    ['a missing Location', ''],
    ['a non-http scheme', 'ftp://example.com/'],
    ['userinfo', 'http://user:pass@example.com/'],
  ] as const) {
    it(`fails ${label} as invalid_redirect`, async () => {
      const outcome = await runHttpCheck(
        `${server.origin}/redirect-to?url=${encodeURIComponent(location)}`,
        options(),
      );
      assert.equal(outcome.errorCode, 'invalid_redirect');
    });
  }
});

describe('Keyword check', () => {
  const body = (size: number, at: number) =>
    `${server.origin}/body?size=${size}&keyword=needle&at=${at}`;

  it('succeeds when the body holds the keyword', async () => {
    const outcome = await runKeywordCheck(
      body(5_000, 100),
      'needle',
      options(),
    );
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.metadata.bytesRead, 5_000);
    assert.ok(outcome.latencyMs !== null);
  });

  it('fails when the body lacks it, and when it is case-different', async () => {
    const lacks = await runKeywordCheck(body(5_000, 100), 'absent', options());
    assert.equal(lacks.errorCode, 'keyword_missing');
    const cased = await runKeywordCheck(body(5_000, 100), 'NEEDLE', options());
    assert.equal(cased.errorCode, 'keyword_missing');
  });

  it('finds it just inside the cap and misses it just past', async () => {
    const inside = await runKeywordCheck(
      body(KEYWORD_BODY_CAP_BYTES + 100, KEYWORD_BODY_CAP_BYTES - 6),
      'needle',
      options(),
    );
    assert.equal(inside.status, 'success');
    const past = await runKeywordCheck(
      body(KEYWORD_BODY_CAP_BYTES + 100, KEYWORD_BODY_CAP_BYTES + 10),
      'needle',
      options(),
    );
    assert.equal(past.errorCode, 'keyword_missing');
    assert.ok(past.metadata.bytesRead <= KEYWORD_BODY_CAP_BYTES);
    assert.equal(past.metadata.bytesRead, KEYWORD_BODY_CAP_BYTES);
  });

  it('misses a keyword that straddles the cap', async () => {
    const outcome = await runKeywordCheck(
      body(KEYWORD_BODY_CAP_BYTES + 100, KEYWORD_BODY_CAP_BYTES - 3),
      'needle',
      options(),
    );
    assert.equal(outcome.errorCode, 'keyword_missing');
  });

  it('times out a stalled body with no latency', async () => {
    const outcome = await runKeywordCheck(`${server.origin}/stall`, 'x', {
      ...options(),
      timeoutSeconds: 1,
    });
    assert.equal(outcome.errorCode, 'timeout');
    assert.equal(outcome.latencyMs, null);
    assert.equal(outcome.metadata.statusCode, 200);
  });

  it('measures keyword latency to the end of the body', async () => {
    const outcome = await runKeywordCheck(
      `${server.origin}/delayed-body?delay=600`,
      'late',
      options(),
    );
    assert.equal(outcome.status, 'success');
    assert.ok((outcome.latencyMs ?? 0) >= 590, `${outcome.latencyMs} ms`);
  });

  it('fails a non-2xx before reading', async () => {
    const outcome = await runKeywordCheck(
      `${server.origin}/error`,
      'x',
      options(),
    );
    assert.equal(outcome.errorCode, 'http_status');
    assert.equal(outcome.metadata.bytesRead, 0);
  });
});
