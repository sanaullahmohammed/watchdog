import config from '@/config/env';
import { createLimiter } from './check-limiter';

/**
 * Process-wide: one instance for every organization's pass. A slot is held
 * from the start of a check until its result is recorded.
 */
export const checkLimiter = createLimiter(
  () => config.monitor.checkConcurrency,
);
