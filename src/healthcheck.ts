import { statSync } from 'node:fs';
import { env } from '@/config';

/**
 * Container healthcheck for the `worker` entrypoint, which serves no HTTP.
 * Asserts the heartbeat file is recent, so a wedged loop fails the check
 * rather than passing because the process happens to still exist.
 */
try {
  const ageMs = Date.now() - statSync(env.worker.heartbeatPath).mtimeMs;
  process.exit(ageMs <= env.worker.heartbeatMaxAgeMs ? 0 : 1);
} catch {
  process.exit(1);
}
