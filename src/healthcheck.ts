import { readFileSync } from 'node:fs';
import { env } from '@/config';
import { assessWorkerHealth } from '@/worker-health';

/**
 * Container healthcheck for the `worker` entrypoint, which serves no HTTP.
 * Reads the worker's health record and fails when the record is stale (the
 * heartbeat timer died) or any loop's last completed pass is overdue (the work
 * stopped while the process lives). No database access. Fails closed.
 */
try {
  const record: unknown = JSON.parse(
    readFileSync(env.worker.heartbeatPath, 'utf8'),
  );
  const { healthy, reason } = assessWorkerHealth(record, Date.now(), {
    overdueMs: env.worker.passOverdueMs,
    maxAgeMs: env.worker.heartbeatMaxAgeMs,
  });
  if (!healthy) {
    process.stderr.write(`unhealthy: ${reason}\n`);
  }
  process.exit(healthy ? 0 : 1);
} catch (error) {
  process.stderr.write(`unhealthy: ${String(error)}\n`);
  process.exit(1);
}
