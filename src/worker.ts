import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { env } from '@/config';
import {
  type CreateDraftFromMonitorCommandResult,
  createDraftFromMonitorCommand,
} from '@/modules/incident/commands/create-draft-from-monitor/create-draft-from-monitor.handler';
import { transitionDueMaintenanceCommand } from '@/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler';
import {
  checkLimiter,
  checkRegistry,
} from '@/modules/monitoring/checks/process-check-limiter';
import {
  type MaintainCheckResultPartitionsCommandResult,
  maintainCheckResultPartitionsCommand,
} from '@/modules/monitoring/commands/maintain-check-result-partitions/maintain-check-result-partitions.handler';
import {
  type QueueDueMonitorChecksCommandResult,
  queueDueMonitorChecksCommand,
} from '@/modules/monitoring/commands/queue-due-monitor-checks/queue-due-monitor-checks.handler';
import {
  type RefreshUptimeRollupsCommandResult,
  refreshUptimeRollupsCommand,
} from '@/modules/monitoring/commands/refresh-uptime-rollups/refresh-uptime-rollups.handler';
import {
  type ListMonitorsAtThresholdQueryResult,
  listMonitorsAtThresholdQuery,
} from '@/modules/monitoring/queries/list-monitors-at-threshold/list-monitors-at-threshold.handler';
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
const MONITOR_LOOP = 'monitor';

/**
 * Background entrypoint. Two loops share the process: maintenance (window
 * transitions, service status and draft reconciliation, uptime rollups,
 * partition maintenance) and the monitor loop (due checks). A later story adds email
 * dispatch. One image, two commands, separate processes that share no memory.
 */
/**
 * One pass across every tenant: the work that is due, then reconciliation
 * (service status, then missed monitor drafts), then the uptime rollup refresh.
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
  // every tenant it visits and opens drafts for every at-threshold monitor of
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
    // One boolean per organization, so it counts once however many steps fail.
    let orgFailed = false;
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
      orgFailed = true;
      logger.error(
        { orgId, err: error },
        'worker pass failed for organization',
      );
    }

    // Draft reconciliation. A breach draft is opened by an event, and events
    // are one-shot; an edit that moves a monitor into failing emits none. The
    // command is idempotent and returns null when a draft or incident exists.
    // Its own try, so a failed reconciliation does not skip it. DOMAIN.md,
    // Consecutive-failure to draft-incident rule, step 6.
    try {
      const atThreshold =
        await app.queryBus.execute<ListMonitorsAtThresholdQueryResult>(
          listMonitorsAtThresholdQuery({ orgId }),
        );
      const opened: string[] = [];
      for (const monitor of atThreshold) {
        try {
          const incidentId =
            await app.commandBus.execute<CreateDraftFromMonitorCommandResult>(
              createDraftFromMonitorCommand({
                orgId,
                monitorId: monitor.id,
                serviceId: monitor.serviceId,
                monitorName: monitor.name,
                failureEpisode: monitor.failureEpisode,
              }),
            );
          if (incidentId !== null) opened.push(monitor.id);
        } catch (error) {
          orgFailed = true;
          logger.error(
            {
              orgId,
              monitorId: monitor.id,
              failureEpisode: monitor.failureEpisode,
              err: error,
            },
            'reconciling a monitor draft failed',
          );
        }
      }
      if (opened.length > 0) {
        logger.warn(
          { orgId, opened },
          'opened monitor drafts no breach event had opened',
        );
      }
    } catch (error) {
      orgFailed = true;
      logger.error(
        { orgId, err: error },
        'draft reconciliation failed for organization',
      );
    }

    // Rollups go after the organization's reconciliation and before partition
    // maintenance below, so a day is rolled up before retention can drop its
    // raw results. It touches only this organization, so a scoped pass runs it
    // too. Its own try, so a failed reconciliation does not skip it.
    try {
      const lost =
        await app.commandBus.execute<RefreshUptimeRollupsCommandResult>(
          refreshUptimeRollupsCommand({ orgId }),
        );
      if (lost) {
        logger.warn(
          { orgId, from: lost.from, to: lost.to },
          'uptime rollups lost to retention before they could be computed',
        );
      }
    } catch (error) {
      orgFailed = true;
      logger.error(
        { orgId, err: error },
        'uptime rollup refresh failed for organization',
      );
    }

    if (orgFailed) failed += 1;
  }

  // After the organization loop, whose rollup step must come first: a day is
  // rolled up before its raw rows are dropped. ARCHITECTURE.md 6.1.
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
 * One monitor tick: every organization's due monitors, queued and not awaited.
 * Each organization's listing runs in parallel and queues its monitors that are
 * not already queued or running; the process-wide limiter admits them
 * round-robin by organization, and the checks finish detached. The tick
 * completes once its listings are done, so one organization's slow targets
 * cannot hold up the next tick for the others. ARCHITECTURE 6.0.1.
 *
 * It rejects, with no cause, when discovery failed, when every visited
 * organization's listing failed, or when work is unsettled (checks queued or
 * running, or a check failed since the last settle) and no check has been
 * recorded or rightly skipped for WORKER_PASS_OVERDUE_MS: a stall, process-wide,
 * so health is red only when nothing at all is saved. A backlog alone is not
 * one, and neither is shutdown. It never maintains partitions or reconciles.
 */
export async function runMonitorPass(
  app: FastifyInstance,
  logger: FastifyBaseLogger,
  // Tests pass their own organizations. The worker never passes this.
  // Tests pass their own `overdueMs` too; the worker never does.
  options: { orgIds?: readonly string[]; overdueMs?: number } = {},
): Promise<void> {
  let orgIds: readonly string[];
  try {
    orgIds = options.orgIds ?? (await listOrganizationIds());
  } catch (error) {
    logger.error({ err: error }, 'tenant discovery failed; skipping this pass');
    throw new Error('tenant discovery failed');
  }

  const settled = await Promise.allSettled(
    orgIds.map((orgId) =>
      app.commandBus.execute<QueueDueMonitorChecksCommandResult>(
        queueDueMonitorChecksCommand({ orgId }),
      ),
    ),
  );

  let failed = 0;
  let due = 0;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      due += result.value.queued + result.value.skipped;
    } else {
      failed += 1;
      logger.error(
        { orgId: orgIds[index], err: result.reason },
        'monitor pass failed for organization',
      );
    }
  });

  if (orgIds.length > 0 && failed === orgIds.length) {
    throw new Error(`every organization failed (${orgIds.length})`);
  }
  // Nothing due, nothing registered: a failure still pending is moot.
  if (failed === 0 && due === 0) checkRegistry.idle();
  // Shutdown drops queued checks on purpose; that is not a stall.
  if (
    !checkLimiter.closed &&
    checkRegistry.stalled(options.overdueMs ?? env.worker.passOverdueMs)
  ) {
    // startLoop logs the rejection as `monitor pass failed`.
    throw new Error('monitor checks stalled');
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
 * reports a pass that did no work. The monitor loop's pass is a tick that only
 * queues checks, so it is short; its checks outlive it and are guarded by the
 * registry, not by this gate.
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

export async function startWorker(
  // Only the test seam passes this; src/index.ts passes nothing.
  options: { orgIds?: readonly string[] } = {},
) {
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
    loops: [MAINTENANCE_LOOP, MONITOR_LOOP],
    logger,
  });
  health.write();
  // Deliberately not unref'd: this timer is what holds the event loop open
  // until a signal arrives. A pending promise is not a ref'd handle. One timer
  // per process writes the record; a future loop adds no second writer.
  const heartbeat = setInterval(() => health.write(), HEARTBEAT_INTERVAL_MS);

  const maintenance = startLoop({
    name: MAINTENANCE_LOOP,
    pass: () => runWorkerPass(app, logger, { orgIds: options.orgIds }),
    intervalMs: env.worker.maintenanceIntervalMs,
    health,
    logger,
  });
  const monitor = startLoop({
    name: MONITOR_LOOP,
    pass: () => runMonitorPass(app, logger, { orgIds: options.orgIds }),
    intervalMs: env.worker.monitorIntervalMs,
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
    monitor.stop();
    // Stop taking new work: checks still waiting for a slot are dropped and
    // stay due for the next worker; checks already running finish.
    checkLimiter.close();

    // Finish the pass in flight, then close. app.close() drains the event bus,
    // so the recomputations a just-committed transition triggered are not cut
    // off by the pool closing underneath them.
    const inFlight = [
      ['maintenance', maintenance.inFlight],
      ['monitor', monitor.inFlight],
    ] as const;
    for (const [name, pending] of inFlight) {
      if (pending) {
        logger.info(`waiting for the ${name} pass in flight`);
      }
    }
    await Promise.all(
      inFlight.map(([, pending]) => pending?.catch(() => undefined)),
    );
    // Checks finish detached from the tick: wait for the running ones and
    // their records before the app and the pool close.
    if (checkRegistry.size > 0) logger.info('waiting for checks in flight');
    await checkRegistry.drain();
    clearInterval(heartbeat);

    await closeWorker(app, logger);
    // No process.exit: both intervals are cleared and every pool is closed, so
    // the process ends once its last handle has.
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
