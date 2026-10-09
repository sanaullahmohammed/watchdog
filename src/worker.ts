import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { env } from '@/config';
import { transitionDueMaintenanceCommand } from '@/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler';
import {
  type MaintainCheckResultPartitionsCommandResult,
  maintainCheckResultPartitionsCommand,
} from '@/modules/monitoring/commands/maintain-check-result-partitions/maintain-check-result-partitions.handler';
import {
  type RecomputeServiceStatusCommandResult,
  recomputeServiceStatusCommand,
} from '@/modules/service/commands/recompute-service-status/recompute-service-status.event-handler';
import { buildApp } from '@/server/build-app';
import sql, { closeDbConnection } from '@/shared/db/postgres';
import { assertTenantBoundRole } from '@/shared/db/runtime-role';
import { listOrganizationIds } from '@/shared/db/tenants';
import { singleFlight } from '@/shared/utils/single-flight';
import { createWorkerHealth, type WorkerHealth } from '@/worker-health';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAINTENANCE_LOOP = 'maintenance';

/**
 * Background entrypoint. ROADMAP phase 5 fills this in with the monitor
 * scheduler, maintenance transitions, uptime rollups, partition maintenance and
 * email dispatch. Today it exists so the two-entrypoint topology is real and
 * testable: one image, two commands, separate processes that share no memory.
 */
/**
 * One pass across every tenant: the work that is due, then reconciliation.
 *
 * Discovery and work are separate steps because the worker has no request and
 * therefore no organization: it learns which tenants exist from Better Auth's
 * table, which is outside WatchDog's RLS, then does the work under each
 * tenant's own transaction. See ARCHITECTURE.md 6.0.
 *
 * One tenant's failure is logged and the pass continues. Abandoning the rest
 * because a single organization errored would let one bad row stop the clock
 * for everyone.
 *
 * A pass that did no work rejects, so the loop does not count it as completed
 * and the healthcheck can see a worker cut off from its database. No work means
 * discovery failed, or at least one organization was visited and every one
 * failed. A pass over no organizations, or where some succeed, resolves. A pass
 * also rejects when check result partition maintenance failed, after the
 * organization work has run. Every rejection carries no cause: a nested
 * database error would escape log redaction.
 */
export async function runWorkerPass(
  app: FastifyInstance,
  logger: FastifyBaseLogger,
  // Tests pass their own organizations. A pass reconciles every service of
  // every tenant it visits, so an unscoped one reaches into whatever another
  // test file is asserting at that moment. The worker never passes this.
  options: {
    orgIds?: readonly string[];
    // Partition maintenance is global DDL. A scoped pass skips it unless a
    // test asks, because the suites share one database. The worker passes neither.
    maintainPartitions?: boolean;
  } = {},
): Promise<void> {
  let orgIds: readonly string[];
  try {
    orgIds = options.orgIds ?? (await listOrganizationIds());
  } catch (error) {
    // Discovery is the one query outside the per-tenant loop. Log it where it
    // happens, then reject: startLoop catches the rejection, so it costs this
    // pass only and the pass is not counted as completed.
    logger.error({ err: error }, 'tenant discovery failed; skipping this pass');
    throw new Error('tenant discovery failed');
  }

  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const moved = await app.commandBus.execute<
        Promise<{ started: number; completed: number }>
      >(transitionDueMaintenanceCommand({ orgId }));

      if (moved.started > 0 || moved.completed > 0) {
        logger.info({ orgId, ...moved }, 'maintenance windows transitioned');
      }

      // Reconciliation. Status recomputation is event-driven and the events
      // are one-shot, so a handler that failed - a transient database error, a
      // process that died mid-flight - leaves last_known_status wrong with
      // nothing to re-trigger it. This is the same recomputation, idempotent
      // and silent when nothing moved. DOMAIN.md, Status recomputation.
      const corrected =
        await app.commandBus.execute<RecomputeServiceStatusCommandResult>(
          recomputeServiceStatusCommand({ orgId }),
        );

      if (corrected.length > 0) {
        // Worth a warning rather than an info: a correction means an event was
        // lost somewhere, and the pass is covering for it.
        logger.warn(
          {
            orgId,
            corrected: corrected.map(
              (change) => `${change.slug}: ${change.from} -> ${change.to}`,
            ),
          },
          'reconciled service status that had drifted from its inputs',
        );
      }
    } catch (error) {
      failed += 1;
      logger.error(
        { orgId, err: error },
        'worker pass failed for organization',
      );
    }
  }

  // After the organization loop, so the rollup step (Story 5.11) can go before
  // it: a day is rolled up before its raw rows are dropped. ARCHITECTURE.md 6.1.
  let maintenanceFailed = false;
  if (options.orgIds === undefined || options.maintainPartitions === true) {
    try {
      const result =
        await app.commandBus.execute<MaintainCheckResultPartitionsCommandResult>(
          maintainCheckResultPartitionsCommand({
            retentionDays: env.monitor.checkResultsRetentionDays,
          }),
        );
      if (result.created > 0 || result.dropped > 0) {
        logger.info(result, 'check result partitions maintained');
      }
    } catch (error) {
      maintenanceFailed = true;
      logger.error({ err: error }, 'check result partition maintenance failed');
    }
  }

  if (orgIds.length > 0 && failed === orgIds.length) {
    throw new Error(`every organization failed (${orgIds.length})`);
  }
  if (maintenanceFailed) {
    throw new Error('check result partition maintenance failed');
  }
}

/**
 * The closing steps of shutdown. Never rejects: a failed app.close() is logged
 * and the pool is still ended, so the process can exit.
 */
export async function closeWorker(
  app: Pick<FastifyInstance, 'close'>,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await app.close();
  } catch (error) {
    logger.error({ err: error }, 'closing the app failed');
  }
  try {
    await closeDbConnection();
  } catch (error) {
    logger.error({ err: error }, 'closing the database connection failed');
  }
}

/**
 * One recurring loop. A pass that outlasts its interval must not overlap the
 * next one: two passes contend on the same rows, fan out duplicate
 * recomputations, and pile up on the connection pool. The gate also gives
 * shutdown something to await. A pass counts as completed only when its
 * promise fulfils; one that rejects does not, which is how runWorkerPass
 * reports a pass that did no work.
 */
export function startLoop(options: {
  name: string;
  pass: () => Promise<void>;
  intervalMs: number;
  health: WorkerHealth;
  logger: FastifyBaseLogger;
}) {
  const { name, pass, intervalMs, health, logger } = options;
  // An unregistered loop would be absent from the record, so the healthcheck
  // could never see it stop.
  if (!health.has(name)) {
    throw new Error(
      `worker loop ${name} is not registered with the health record`,
    );
  }
  const gate = singleFlight(async () => {
    health.started(name);
    await pass();
    health.completed(name);
  });
  const tick = () => {
    if (gate.inFlight) {
      logger.warn(`${name} pass still running; skipping this tick`);
      return;
    }
    // A rejected pass is logged here, not left unhandled, which would end the
    // process.
    gate.run().catch((error) => {
      logger.error({ err: error }, `${name} pass failed`);
    });
  };
  const timer = setInterval(tick, intervalMs);

  // Run once at startup rather than waiting a whole interval, so a restart
  // does not leave a window sitting past its time.
  tick();

  return {
    stop() {
      clearInterval(timer);
    },
    get inFlight(): Promise<void> | null {
      return gate.inFlight;
    },
  };
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

  // Before any pass: a role exempt from RLS would reach every tenant's rows.
  try {
    await assertTenantBoundRole(sql);
  } catch (error) {
    logger.fatal(error);
    process.exit(1);
  }

  const health = createWorkerHealth({
    path: env.worker.heartbeatPath,
    loops: [MAINTENANCE_LOOP],
    logger,
  });
  health.write();
  // Deliberately not unref'd: this timer is what holds the event loop open
  // until a signal arrives. A pending promise is not a ref'd handle. One timer
  // per process writes the record; a future loop adds no second writer.
  const heartbeat = setInterval(() => health.write(), HEARTBEAT_INTERVAL_MS);

  const maintenance = startLoop({
    name: MAINTENANCE_LOOP,
    pass: () => runWorkerPass(app, logger),
    intervalMs: env.worker.maintenanceIntervalMs,
    health,
    logger,
  });

  logger.info('Worker is ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Worker is shutting down');
    maintenance.stop();

    // Finish the pass in flight, then close. app.close() drains the event bus,
    // so the recomputations a just-committed transition triggered are not cut
    // off by the pool closing underneath them.
    if (maintenance.inFlight) {
      logger.info('waiting for the maintenance pass in flight');
      await maintenance.inFlight.catch(() => undefined);
    }
    clearInterval(heartbeat);

    await closeWorker(app, logger);
    // No process.exit: both intervals are cleared and every pool is closed, so
    // the process ends once its last handle has.
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
