import { writeFileSync } from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { env } from '@/config';
import { transitionDueMaintenanceCommand } from '@/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler';
import { buildApp } from '@/server/build-app';
import { closeDbConnection } from '@/shared/db/postgres';
import { listOrganizationIds } from '@/shared/db/tenants';
import { singleFlight } from '@/shared/utils/single-flight';

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
  logger: FastifyBaseLogger,
): Promise<void> {
  let orgIds: string[];
  try {
    orgIds = await listOrganizationIds();
  } catch (error) {
    // Discovery is the one query outside the per-tenant loop, so its failure
    // used to reject out of a pass nobody awaited: an unhandled rejection,
    // which ends the process. A database blip should cost this pass only.
    logger.error({ error }, 'tenant discovery failed; skipping this pass');
    return;
  }

  for (const orgId of orgIds) {
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
  // The worker builds the same instance the api does, without listening. That
  // is what registers the command handlers in the DI container; the dependency
  // graph is identical across both entrypoints by design.
  //
  // Its logger is the app's, not a second pino instance. Built with
  // `logger: false`, the container handed every handler a no-op logger, so a
  // status recomputation that failed here logged nowhere at all (Epic 2
  // retrospective, R-6).
  const app = await buildApp({ logger: { level: env.log.level } });
  await app.ready();
  const logger = app.log;

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

  // A pass that outlasts its interval must not overlap the next one: two
  // passes contend on the same rows, fan out duplicate recomputations, and
  // pile up on the connection pool. The gate also gives shutdown something to
  // await.
  const pass = singleFlight(() => runMaintenancePass(app, logger));
  const tick = () => {
    if (pass.inFlight) {
      logger.warn('maintenance pass still running; skipping this tick');
      return;
    }
    void pass.run();
  };

  const maintenance = setInterval(tick, env.worker.maintenanceIntervalMs);

  // Run once at startup rather than waiting a whole interval, so a restart
  // does not leave a window sitting past its time.
  tick();

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

    // Finish the pass in flight, then close. app.close() drains the event bus,
    // so the recomputations a just-committed transition triggered are not cut
    // off by the pool closing underneath them.
    if (pass.inFlight) {
      logger.info('waiting for the maintenance pass in flight');
      await pass.inFlight.catch(() => undefined);
    }

    await app.close();
    await closeDbConnection();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
