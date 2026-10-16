import type { CheckOutcome } from '@/modules/monitoring/checks/check-outcome';
import type { MonitorEntity } from './monitor.types';

const DAY_MS = 86_400_000;

export interface SslWarning {
  fingerprint: string;
  expiresAt: Date;
}

/**
 * The certificate a result warns about, or null. Ignores `outcome.status` and
 * the monitor's `enabled`: an expired or untrusted certificate inside the
 * window warns, and a negative remaining time is inside it.
 */
export function sslWarningOf(
  monitor: Pick<MonitorEntity, 'type' | 'config'>,
  outcome: Pick<CheckOutcome<object>, 'checkedAt' | 'metadata'>,
): SslWarning | null {
  if (monitor.type !== 'ssl_expiry') {
    return null;
  }
  const warnDays = monitor.config?.warnDays;
  if (typeof warnDays !== 'number' || !Number.isFinite(warnDays)) {
    return null;
  }
  const metadata = outcome.metadata as {
    certificateFingerprint?: unknown;
    certificateExpiresAt?: unknown;
  } | null;
  const fingerprint = metadata?.certificateFingerprint;
  const expires = metadata?.certificateExpiresAt;
  if (typeof fingerprint !== 'string' || typeof expires !== 'string') {
    return null;
  }
  if (fingerprint === '') {
    return null;
  }
  const expiresMs = Date.parse(expires);
  if (Number.isNaN(expiresMs)) {
    return null;
  }
  if (expiresMs - outcome.checkedAt.getTime() > warnDays * DAY_MS) {
    return null;
  }
  return { fingerprint, expiresAt: new Date(expiresMs) };
}
