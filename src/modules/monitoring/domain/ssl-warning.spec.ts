import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MonitorEntity } from './monitor.types';
import { sslWarningOf } from './ssl-warning';

const DAY = 86_400_000;
const checkedAt = new Date('2026-10-16T12:00:00Z');
const monitor = {
  type: 'ssl_expiry',
  config: { warnDays: 14 },
} as Pick<MonitorEntity, 'type' | 'config'>;

const meta = (offsetMs: number, fingerprint = 'AA:BB') => ({
  checkedAt,
  metadata: {
    certificateFingerprint: fingerprint,
    certificateExpiresAt: new Date(
      checkedAt.getTime() + offsetMs,
    ).toISOString(),
    daysRemaining: 0,
  },
});

describe('sslWarningOf', () => {
  it('warns exactly at the boundary, not 1 ms past it', () => {
    assert.ok(sslWarningOf(monitor, meta(14 * DAY)));
    assert.equal(sslWarningOf(monitor, meta(14 * DAY + 1)), null);
    assert.ok(sslWarningOf(monitor, meta(14 * DAY - 1)));
  });

  it('treats a negative remaining time as inside the window', () => {
    const warning = sslWarningOf(monitor, meta(-DAY));
    assert.equal(warning?.fingerprint, 'AA:BB');
    assert.equal(warning?.expiresAt.getTime(), checkedAt.getTime() - DAY);
  });

  it('ignores a non-SSL monitor', () => {
    assert.equal(sslWarningOf({ ...monitor, type: 'http' }, meta(DAY)), null);
  });

  it('ignores null metadata', () => {
    assert.equal(
      sslWarningOf(monitor, {
        checkedAt,
        metadata: {
          certificateFingerprint: null,
          certificateExpiresAt: null,
          daysRemaining: null,
        },
      }),
      null,
    );
  });

  it('ignores a config without warnDays', () => {
    assert.equal(sslWarningOf({ ...monitor, config: {} }, meta(DAY)), null);
  });

  it('ignores metadata that is itself null', () => {
    assert.equal(
      sslWarningOf(monitor, { checkedAt, metadata: null as never }),
      null,
    );
  });

  it('ignores a non-string fingerprint', () => {
    assert.equal(
      sslWarningOf(monitor, {
        checkedAt,
        metadata: {
          certificateFingerprint: 42,
          certificateExpiresAt: checkedAt.toISOString(),
        },
      }),
      null,
    );
  });

  it('ignores an empty fingerprint', () => {
    assert.equal(sslWarningOf(monitor, meta(DAY, '')), null);
  });

  it('ignores an unparseable expiry', () => {
    assert.equal(
      sslWarningOf(monitor, {
        checkedAt,
        metadata: {
          certificateFingerprint: 'AA',
          certificateExpiresAt: 'not a date',
          daysRemaining: null,
        },
      }),
      null,
    );
  });
});
