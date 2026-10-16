/**
 * env-schema cannot express a cross-field rule. Time since the last completion
 * reaches about one interval plus the pass's duration, so a pass may take up to
 * the threshold minus the interval before the check fails it; at or below the
 * interval that allowance is nothing. Pure and apart from `env.ts`, so a unit
 * spec can call it without a `.env`.
 */
export function assertWorkerIntervals(values: {
  WORKER_PASS_OVERDUE_MS: number;
  WORKER_MAINTENANCE_INTERVAL_MS: number;
  WORKER_MONITOR_INTERVAL_MS: number;
}): void {
  for (const interval of [
    'WORKER_MAINTENANCE_INTERVAL_MS',
    'WORKER_MONITOR_INTERVAL_MS',
  ] as const) {
    if (values.WORKER_PASS_OVERDUE_MS <= values[interval]) {
      throw new Error(
        `WORKER_PASS_OVERDUE_MS (${values.WORKER_PASS_OVERDUE_MS}) must be greater than ${interval} (${values[interval]})`,
      );
    }
  }
}
