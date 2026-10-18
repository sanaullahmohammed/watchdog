import config from '@/config/env';
import { createLimiter } from './check-limiter';
import { createCheckRegistry } from './check-registry';

/**
 * Process-wide: one instance for every organization's pass. A slot is held
 * from the start of a check until its result is recorded.
 */
export const checkLimiter = createLimiter(
  () => config.monitor.checkConcurrency,
);

/**
 * Process-wide: the monitors queued or running. ARCHITECTURE 6.0.1. Tests that
 * queue checks `drain()` it before asserting.
 */
export const checkRegistry = createCheckRegistry();
