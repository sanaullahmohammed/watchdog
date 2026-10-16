import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import { guardTarget } from './guarded-connect';

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
