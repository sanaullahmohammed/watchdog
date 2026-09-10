import { writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { env } from '@/config';
import { transitionDueMaintenanceCommand } from '@/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler';
import { buildApp } from '@/server/build-app';
import { closeDbConnection } from '@/shared/db/postgres';
import { listOrganizationIds } from '@/shared/db/tenants';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Background entrypoint. ROADMAP phase 5 fills this in with the monitor
 * scheduler, maintenance transitions, uptime rollups, partition maintenance and
 * email dispatch. Today it exists so the two-entrypoint topology is real and
 * testable: one image, two commands, separate processes that share no memory.
 */
/**
 * One maintenance pass across every tenant.
 *
 * Discovery and work are separate steps because the worker has no request and
 * therefore no organization: it learns which tenants exist from Better Auth's
 * table, which is outside WatchDog's RLS, then does the work under each
 * tenant's own transaction. See ARCHITECTURE.md 6.0.
 *
 * One tenant's failure is logged and the pass continues. Abandoning the rest
 * because a single organization errored would let one bad row stop the clock
 * for everyone.
 */
export async function runMaintenancePass(
  app: FastifyInstance,
  logger: pino.Logger,
): Promise<void> {
  for (const orgId of await listOrganizationIds()) {
    try {
      const moved = await app.commandBus.execute<
        Promise<{ started: number; completed: number }>
      >(transitionDueMaintenanceCommand({ orgId }));

      if (moved.started > 0 || moved.completed > 0) {
        logger.info({ orgId, ...moved }, 'maintenance windows transitioned');
      }
    } catch (error) {
      logger.error(
        { orgId, error },
        'maintenance pass failed for organization',
      );
    }
  }
}

export async function startWorker() {
  const logger = pino({ level: env.log.level });

  // The worker builds the same instance the api does, without listening. That
  // is what registers the command handlers in the DI container; the dependency
  // graph is identical across both entrypoints by design.
  const app = await buildApp({ logger: false });
  await app.ready();

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

  const maintenance = setInterval(() => {
    void runMaintenancePass(app, logger);
  }, env.worker.maintenanceIntervalMs);

  // Run once at startup rather than waiting a whole interval, so a restart
  // does not leave a window sitting past its time.
  void runMaintenancePass(app, logger);

  logger.info('Worker is ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Worker is shutting down');
    clearInterval(heartbeat);
    clearInterval(maintenance);
    await app.close();
    await closeDbConnection();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
