import config from '@/config/env';
import type { MonitorEntity } from '../domain/monitor.types';
import type { CheckOutcome } from './check-outcome';
import { runHttpCheck } from './http-check';
import { runKeywordCheck } from './keyword-check';
import { runSslExpiryCheck } from './ssl-expiry-check';
import { runTcpCheck } from './tcp-check';

/**
 * Runs the adapter for a monitor's type. The adapter's own deadline is the
 * timeout; allowed ranges are read at call time.
 */
export function runCheck(
  monitor: MonitorEntity,
): Promise<CheckOutcome<object>> {
  const options = {
    timeoutSeconds: monitor.timeoutSeconds,
    allowedRanges: config.monitor.allowedCidrs,
  };
  switch (monitor.type) {
    case 'http':
      return runHttpCheck(monitor.target, options);
    case 'keyword':
      return runKeywordCheck(
        monitor.target,
        monitor.config.keyword ?? '',
        options,
      );
    case 'tcp':
      return runTcpCheck(monitor.target, options);
    case 'ssl_expiry':
      return runSslExpiryCheck(monitor.target, options);
  }
}
