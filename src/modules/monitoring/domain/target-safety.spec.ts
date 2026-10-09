import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { afterEach, describe, it, mock } from 'node:test';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import {
  assertTargetAllowed,
  classifyAddress,
  type HostLookup,
  parseTarget,
} from './target-safety';

const never: HostLookup = async () => {
  throw new Error('lookup must not run');
};
const answering =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses;

const refused = async (
  type: Parameters<typeof assertTargetAllowed>[0],
  target: string,
  options: Parameters<typeof assertTargetAllowed>[2] = { lookup: never },
) =>
  assert.rejects(
    assertTargetAllowed(type, target, options),
    /^Error: Invalid input\. target: /,
  );

describe('classifyAddress', () => {
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['::', 'unspecified'],
    ['::0.0.0.5', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::FFFF:A00:1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
  ];
  for (const [address, reason] of blocked) {
    it(`blocks ${address} as ${reason}`, () => {
      assert.equal(classifyAddress(address), reason);
    });
  }

  for (const address of [
    '203.0.113.10',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '2001:db8::1',
    '2606:4700::1111',
    '::ffff:203.0.113.10',
    // Deliberately unclassified: NAT64 and CGNAT (ARCHITECTURE 6.5).
    '64:ff9b::7f00:1',
    '100.64.0.1',
  ]) {
    it(`does not block ${address}`, () => {
      assert.equal(classifyAddress(address), null);
    });
  }
});

describe('parseTarget', () => {
  it("reads each type's host", () => {
    assert.deepEqual(parseTarget('http', 'https://Example.COM./x'), {
      host: 'example.com',
    });
    assert.deepEqual(parseTarget('keyword', 'http://[::1]:8080/'), {
      host: '::1',
    });
    assert.deepEqual(parseTarget('tcp', '[::1]:22'), { host: '::1', port: 22 });
    assert.deepEqual(parseTarget('tcp', 'db.internal:5432'), {
      host: 'db.internal',
      port: 5432,
    });
    assert.deepEqual(parseTarget('ssl_expiry', 'example.com'), {
      host: 'example.com',
    });
    assert.deepEqual(parseTarget('ssl_expiry', 'example.com:8443'), {
      host: 'example.com',
      port: 8443,
    });
    assert.deepEqual(parseTarget('ssl_expiry', '[2001:db8::1]'), {
      host: '2001:db8::1',
    });
  });

  it('normalises disguised IPv4 forms to the address they are', () => {
    assert.equal(parseTarget('http', 'http://2130706433/').host, '127.0.0.1');
    assert.equal(parseTarget('http', 'http://0x7f.1/').host, '127.0.0.1');
  });

  it('reads every disguised IPv4 form in tcp and ssl_expiry hosts too', () => {
    assert.equal(parseTarget('tcp', '127.1:80').host, '127.0.0.1');
    assert.equal(parseTarget('tcp', '2130706433:80').host, '127.0.0.1');
    assert.equal(parseTarget('ssl_expiry', '0x7f.1').host, '127.0.0.1');
  });

  it('reads an IDN host punycoded, for every type', () => {
    assert.equal(parseTarget('tcp', 'bücher.de:443').host, 'xn--bcher-kva.de');
    assert.equal(
      parseTarget('ssl_expiry', 'bücher.de').host,
      'xn--bcher-kva.de',
    );
    assert.equal(
      parseTarget('http', 'https://bücher.de/').host,
      'xn--bcher-kva.de',
    );
  });

  it('refuses a host with URL syntax in it, and a zoned IPv6', () => {
    for (const [type, target] of [
      ['tcp', '10.0.0.1@203.0.113.5:80'],
      ['tcp', '10.0.0.1/x:80'],
      ['ssl_expiry', '10.0.0.1?x'],
      ['ssl_expiry', '10.0.0.1#x'],
      ['ssl_expiry', '10.0.0.1\\x'],
      ['tcp', '[2001:db8::1%eth0]:80'],
    ] as const) {
      assert.throws(() => parseTarget(type, target), /target: /, target);
    }
  });

  it('refuses malformed targets', () => {
    for (const [type, target] of [
      ['http', 'http://203.0.113.10:0/'],
      ['http', ' https://203.0.113.10/a\tb '],
      ['http', 'https://203.0.113.10/\u0000'],
      ['tcp', 'localhost..:80'],
      ['tcp', 'a..b:80'],
      ['tcp', '.example.com:80'],
      ['tcp', `${'a'.repeat(64)}.example:80`],
      ['tcp', ' 203.0.113.10:80'],
      ['ssl_expiry', 'example.com..'],
      ['http', 'ftp://x/'],
      ['http', '/relative'],
      ['http', 'https://u:p@x/'],
      ['tcp', 'host'],
      ['tcp', 'host:0'],
      ['tcp', 'host:65536'],
      ['tcp', '::1:80'],
      ['ssl_expiry', '::1'],
      ['ssl_expiry', 'host:99999'],
      ['ssl_expiry', 'two words'],
    ] as const) {
      assert.throws(() => parseTarget(type, target), /target: /, target);
    }
  });
});

describe('assertTargetAllowed', () => {
  it('refuses localhost and *.localhost without a lookup', async () => {
    await refused('http', 'http://localhost/');
    await refused('http', 'http://LOCALHOST./');
    await refused('tcp', 'api.localhost:80');
  });

  it('applies the allowed list to localhost like any address', async () => {
    const both = parseAllowedCidrs('127.0.0.0/8, ::1/128');
    await assertTargetAllowed('http', 'http://localhost/', {
      allowedRanges: both,
      lookup: never,
    });
    await assertTargetAllowed('tcp', 'api.localhost:80', {
      allowedRanges: both,
      lookup: never,
    });
    // ::1 is still blocked when only the IPv4 loopback is allowed.
    await refused('http', 'http://localhost/', {
      allowedRanges: parseAllowedCidrs('127.0.0.0/8'),
      lookup: never,
    });
  });

  it('refuses a disguised loopback host', async () => {
    await refused('tcp', '127.1:80');
    await refused('ssl_expiry', '2130706433');
  });

  it('never names an address that came from a lookup', async () => {
    await assert.rejects(
      assertTargetAllowed('http', 'http://internal.example/', {
        lookup: answering('10.9.8.7'),
      }),
      (error: Error) =>
        /internal\.example/.test(error.message) &&
        /private/.test(error.message) &&
        !error.message.includes('10.9.8.7'),
    );
  });

  it('refuses a blocked literal without a lookup', async () => {
    await refused('http', 'http://10.0.0.1/');
    await refused('tcp', '[::ffff:7f00:1]:80');
    await refused('ssl_expiry', '169.254.169.254');
  });

  it('accepts a public literal', async () => {
    await assertTargetAllowed('http', 'https://203.0.113.10/', {
      lookup: never,
    });
  });

  it('refuses a name when any resolved address is blocked', async () => {
    await refused('http', 'http://mixed.example/', {
      lookup: answering('203.0.113.5', '10.0.0.9'),
    });
    await refused('tcp', 'rebind.example:80', {
      lookup: answering('::ffff:7f00:1'),
    });
  });

  it('accepts a name whose addresses are all public', async () => {
    await assertTargetAllowed('http', 'http://ok.example/', {
      lookup: answering('203.0.113.5', '2001:db8::1'),
    });
  });

  it('accepts a blocked address inside an allowed range', async () => {
    const allowedRanges = parseAllowedCidrs('10.20.0.0/16, fd00:1234::/32');
    await assertTargetAllowed('tcp', '10.20.3.4:22', {
      allowedRanges,
      lookup: never,
    });
    await assertTargetAllowed('http', 'http://internal.example/', {
      allowedRanges,
      lookup: answering('fd00:1234::7'),
    });
    await assertTargetAllowed('http', 'http://[::ffff:10.20.0.1]/', {
      allowedRanges,
      lookup: never,
    });
    // Outside the range is still refused.
    await refused('tcp', '10.21.0.1:22', { allowedRanges, lookup: never });
  });

  it('accepts when the lookup fails', async () => {
    await assertTargetAllowed('http', 'http://nxdomain.example/', {
      lookup: async () => {
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
  });

  it('accepts when the lookup exceeds its time limit, and aborts it', async () => {
    const started = Date.now();
    let signal: AbortSignal | undefined;
    await assertTargetAllowed('http', 'http://slow.example/', {
      lookup: (_host, abort) => {
        signal = abort;
        return new Promise(() => {});
      },
      lookupTimeoutMs: 50,
    });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(signal?.aborted, true);
  });
});

describe('default resolver', () => {
  const enodata = () =>
    Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' });

  afterEach(() => mock.restoreAll());

  it('refuses a private A with an AAAA that has no data', async () => {
    mock.method(Resolver.prototype, 'resolve4', async () => ['10.1.2.3']);
    mock.method(Resolver.prototype, 'resolve6', async () => {
      throw enodata();
    });
    await refused('http', 'http://a.example/', {});
  });

  it('refuses a private AAAA alone', async () => {
    mock.method(Resolver.prototype, 'resolve4', async () => {
      throw enodata();
    });
    mock.method(Resolver.prototype, 'resolve6', async () => ['fd00::1']);
    await refused('http', 'http://b.example/', {});
  });

  it('accepts when both queries fail', async () => {
    mock.method(Resolver.prototype, 'resolve4', async () => {
      throw enodata();
    });
    mock.method(Resolver.prototype, 'resolve6', async () => {
      throw enodata();
    });
    await assertTargetAllowed('http', 'http://c.example/');
  });

  it('cancels a hung query when the time limit aborts it', async () => {
    const hang = () => new Promise<string[]>(() => {});
    mock.method(Resolver.prototype, 'resolve4', hang);
    mock.method(Resolver.prototype, 'resolve6', hang);
    const cancel = mock.method(Resolver.prototype, 'cancel', () => {});
    await assertTargetAllowed('http', 'http://d.example/', {
      lookupTimeoutMs: 50,
    });
    assert.equal(cancel.mock.callCount(), 1);
  });
});

describe('parseAllowedCidrs', () => {
  it('accepts strict CIDRs and refuses bits past the prefix', () => {
    assert.equal(
      parseAllowedCidrs('10.0.0.0/8, ::ffff:10.0.0.0/104').length,
      2,
    );
    for (const bad of ['::ffff:10.0.0.0/8', '10.0.0.1/8']) {
      assert.throws(
        () => parseAllowedCidrs(bad),
        /MONITOR_ALLOWED_CIDRS.*invalid entry/,
        bad,
      );
    }
  });

  it('is empty by default and trims entries', () => {
    assert.deepEqual(parseAllowedCidrs(''), []);
    assert.equal(parseAllowedCidrs(' 10.0.0.0/8 , fd00::/8 ,').length, 2);
  });

  it('throws on an invalid entry, naming it', () => {
    for (const bad of [
      '10.0.0.0',
      '10.0.0.0/33',
      'nope/8',
      '::/129',
      '10.0.0.0/8/8',
    ]) {
      assert.throws(
        () => parseAllowedCidrs(bad),
        /MONITOR_ALLOWED_CIDRS.*invalid entry/,
      );
    }
  });
});
