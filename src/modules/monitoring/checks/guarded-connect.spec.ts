import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import { guardHost, guardTarget, parseCheckTarget } from './guarded-connect';

const guard = (...addresses: string[]) =>
  guardTarget(new URL('http://monitor.example.test/'), {
    allowedRanges: parseAllowedCidrs('10.0.0.0/8'),
    lookup: async () => addresses,
    signal: new AbortController().signal,
    redirect: false,
  });

const call = (
  lookup: Awaited<ReturnType<typeof guard>>['lookup'],
  options: Parameters<typeof lookup>[1],
) =>
  new Promise<unknown[]>((resolve) => {
    lookup('monitor.example.test', options, (...args) => resolve(args));
  });

describe('guardTarget pinned lookup', () => {
  it('yields every classified address for { all: true }', async () => {
    const { lookup } = await guard('10.0.0.5', '93.184.216.34', '2606:2800::1');
    assert.deepEqual(await call(lookup, { all: true }), [
      null,
      [
        { address: '10.0.0.5', family: 4 },
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800::1', family: 6 },
      ],
    ]);
  });

  it('yields the first address and its family otherwise', async () => {
    const { lookup } = await guard('2606:2800::1', '10.0.0.5');
    for (const options of [{}, 4, undefined]) {
      assert.deepEqual(await call(lookup, options), [null, '2606:2800::1', 6]);
    }
  });

  it('refuses when any address is blocked', async () => {
    await assert.rejects(guard('10.0.0.5', '127.0.0.1'), /loopback/);
  });
});

describe('guardHost', () => {
  it('refuses with the same message as guardTarget', async () => {
    const options = {
      allowedRanges: parseAllowedCidrs(''),
      lookup: async () => ['10.0.0.1'],
      signal: new AbortController().signal,
      redirect: false,
    };
    const viaUrl = await guardTarget(
      new URL('http://monitor.example.test/'),
      options,
    ).catch((e: Error) => e.message);
    const viaHost = await guardHost('monitor.example.test', options).catch(
      (e: Error) => e.message,
    );
    assert.match(String(viaHost), /resolves to/);
    assert.equal(viaHost, viaUrl);
  });
});

describe('parseCheckTarget', () => {
  it('defaults ssl_expiry to port 443', () => {
    assert.deepEqual(parseCheckTarget('ssl_expiry', 'Example.com'), {
      host: 'example.com',
      port: 443,
    });
  });
  it('keeps an explicit port', () => {
    assert.deepEqual(parseCheckTarget('ssl_expiry', 'example.com:8443'), {
      host: 'example.com',
      port: 8443,
    });
    assert.deepEqual(parseCheckTarget('tcp', 'example.com:25'), {
      host: 'example.com',
      port: 25,
    });
  });
  it('unbrackets IPv6', () => {
    assert.deepEqual(parseCheckTarget('tcp', '[2606:2800::1]:443'), {
      host: '2606:2800::1',
      port: 443,
    });
  });
  it('refuses what the parser refuses', () => {
    assert.throws(() => parseCheckTarget('tcp', 'example.com'), {
      code: 'target_refused',
    });
    assert.throws(() => parseCheckTarget('ssl_expiry', 'a b'), {
      code: 'target_refused',
    });
  });
});
