import { renameSync, writeFileSync } from 'node:fs';

/**
 * What the worker tells its healthcheck. The heartbeat timer alone proves only
 * that the event loop turns; the per-loop timestamps prove the work is done.
 * This file must not import `@/config`: the decision is unit-tested without a
 * database configuration.
 */
export interface LoopHealth {
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
}

export interface WorkerHealthRecord {
  bootedAt: string;
  writtenAt: string;
  loops: Record<string, LoopHealth>;
}

export interface WorkerHealthLimits {
  /** A loop whose last completion (or boot) is older than this is unhealthy. */
  overdueMs: number;
  /** A record older than this means the heartbeat timer is dead. */
  maxAgeMs: number;
}

export interface WorkerHealthAssessment {
  healthy: boolean;
  reason: string;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Pure: the record, the current time and the limits decide. Fails closed on
 * anything malformed. A timestamp in the future counts as age 0, because the
 * clock can step back.
 */
export function assessWorkerHealth(
  record: unknown,
  now: number,
  limits: WorkerHealthLimits,
): WorkerHealthAssessment {
  const unhealthy = (reason: string) => ({ healthy: false, reason });
  const age = (time: number) => Math.max(0, now - time);

  if (typeof record !== 'object' || record === null) {
    return unhealthy('heartbeat record is not an object');
  }
  const { bootedAt, writtenAt, loops } = record as Record<string, unknown>;

  const booted = parseTime(bootedAt);
  if (booted === null) {
    return unhealthy('bootedAt is not a valid date');
  }
  const written = parseTime(writtenAt);
  if (written === null) {
    return unhealthy('writtenAt is not a valid date');
  }
  if (typeof loops !== 'object' || loops === null || Array.isArray(loops)) {
    return unhealthy('record has no loops');
  }
  const entries = Object.entries(loops as Record<string, unknown>);
  if (entries.length === 0) {
    return unhealthy('record has no loops');
  }

  if (age(written) > limits.maxAgeMs) {
    return unhealthy(
      `heartbeat record is ${age(written)} ms old; the limit is ${limits.maxAgeMs} ms`,
    );
  }

  for (const [name, loop] of entries) {
    if (
      typeof loop !== 'object' ||
      loop === null ||
      !('lastCompletedAt' in loop)
    ) {
      return unhealthy(`loop ${name} has no lastCompletedAt`);
    }
    const completedRaw = (loop as Record<string, unknown>).lastCompletedAt;
    // Only an explicit null means "never completed", measured from boot.
    let reference: number;
    if (completedRaw === null) {
      reference = booted;
    } else {
      const completed = parseTime(completedRaw);
      if (completed === null) {
        return unhealthy(
          `loop ${name} has a lastCompletedAt that is not a date`,
        );
      }
      reference = completed;
    }
    if (age(reference) > limits.overdueMs) {
      return unhealthy(
        `loop ${name} has not completed a pass for ${age(reference)} ms; the limit is ${limits.overdueMs} ms`,
      );
    }
  }

  return { healthy: true, reason: 'ok' };
}

interface HealthLogger {
  error(object: unknown, message?: string): void;
}

export function createWorkerHealth(options: {
  path: string;
  loops: readonly string[];
  logger: HealthLogger;
}) {
  const { path, logger } = options;
  const bootedAt = new Date().toISOString();
  const loops: Record<string, LoopHealth> = {};
  for (const name of options.loops) {
    loops[name] = { lastStartedAt: null, lastCompletedAt: null };
  }

  function loopFor(name: string): LoopHealth {
    const loop = loops[name];
    if (!loop) {
      throw new Error(`unknown worker loop: ${name}`);
    }
    return loop;
  }

  // Written beside the target and renamed over it, so a check never reads a
  // half-written record. A failure never fails a pass.
  function write(): void {
    try {
      const record: WorkerHealthRecord = {
        bootedAt,
        writtenAt: new Date().toISOString(),
        loops,
      };
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(record));
      renameSync(temporary, path);
    } catch (error) {
      logger.error({ error }, 'Failed to write worker heartbeat');
    }
  }

  return {
    started(name: string) {
      loopFor(name).lastStartedAt = new Date().toISOString();
      write();
    },
    completed(name: string) {
      loopFor(name).lastCompletedAt = new Date().toISOString();
      write();
    },
    write,
    has(name: string) {
      return name in loops;
    },
  };
}

export type WorkerHealth = ReturnType<typeof createWorkerHealth>;
