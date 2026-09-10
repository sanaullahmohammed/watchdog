import { writeFileSync } from 'node:fs';
import pino from 'pino';
import { env } from '@/config';
import { closeDbConnection } from '@/shared/db/postgres';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Background entrypoint. ROADMAP phase 5 fills this in with the monitor
 * scheduler, maintenance transitions, uptime rollups, partition maintenance and
 * email dispatch. Today it exists so the two-entrypoint topology is real and
 * testable: one image, two commands, separate processes that share no memory.
 */
export function startWorker() {
  const logger = pino({ level: env.log.level });

  const writeHeartbeat = () => {
    try {
      writeFileSync(env.worker.heartbeatPath, new Date().toISOString());
    } catch (error) {
      logger.error({ error }, 'Failed to write worker heartbeat');
    }
  };

  writeHeartbeat();
  // Deliberately not unref'd: this timer is what holds the event loop open
  // until a signal arrives. A pending promise is not a ref'd handle.
  const heartbeat = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

  logger.info('Worker is ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Worker is shutting down');
    clearInterval(heartbeat);
    await closeDbConnection();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
