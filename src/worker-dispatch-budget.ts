import { SMTP_TIMEOUTS } from '@/modules/notification/infrastructure/smtp-email-sender';

// Its own file, so a unit spec can import it without the config `worker.ts` loads.
/**
 * What one dispatch phase may spend claiming: a pass plus one send must still
 * finish inside the health limit, so it is the shorter of the pass interval and
 * what the limit leaves after an interval and a send (the SMTP overall limit
 * plus 10 s of margin). Never negative.
 */
export function dispatchBudgetMs(
  intervalMs: number,
  overdueMs: number,
): number {
  return Math.max(
    0,
    Math.min(
      intervalMs,
      overdueMs - intervalMs - (SMTP_TIMEOUTS.overall + 10_000),
    ),
  );
}
