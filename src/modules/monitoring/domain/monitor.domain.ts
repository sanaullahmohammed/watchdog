import { randomUUID } from 'node:crypto';
import { monitorStateOf } from '@/shared/domain/monitor-state';
import type { MonitorDerivedState } from '@/shared/domain/status-inputs';
import { InvalidMonitorInputError } from './monitor.errors';
import type {
  CreateMonitorProps,
  MonitorConfig,
  MonitorEntity,
  MonitorType,
  UpdateMonitorProps,
} from './monitor.types';
import { MONITOR_DEFAULT_ENABLED, MONITOR_LIMITS } from './monitor-limits';
import { parseTarget } from './target-safety';

type Problem = { field: string; message: string };

/** The fields the cross-field and per-type rules read. */
type Checkable = {
  type: MonitorType;
  target: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  config: MonitorConfig;
};

/**
 * Rules a request schema cannot express because they relate fields to each
 * other or to the monitor's type. Collects every problem so one refusal names
 * them all, as `assertMatchesSchema` does.
 */
function problemsOf(monitor: Checkable): Problem[] {
  const problems: Problem[] = [];

  if (monitor.timeoutSeconds >= monitor.intervalSeconds) {
    problems.push({
      field: 'timeoutSeconds',
      message: `must be below intervalSeconds (${monitor.intervalSeconds})`,
    });
  }

  try {
    parseTarget(monitor.type, monitor.target);
  } catch (error) {
    if (!(error instanceof InvalidMonitorInputError)) throw error;
    // Re-collected below with the others rather than thrown alone.
    problems.push({
      field: 'target',
      message: error.message.replace(/^Invalid input\. target: /, ''),
    });
  }

  const { keyword, warnDays } = monitor.config;
  if (monitor.type === 'keyword' && keyword === undefined) {
    problems.push({
      field: 'config/keyword',
      message: 'is required for a keyword monitor',
    });
  }
  if (monitor.type === 'ssl_expiry' && warnDays === undefined) {
    problems.push({
      field: 'config/warnDays',
      message: 'is required for an ssl_expiry monitor',
    });
  }
  if (keyword !== undefined && monitor.type !== 'keyword') {
    problems.push({
      field: 'config/keyword',
      message: `is not allowed for a ${monitor.type} monitor`,
    });
  }
  if (warnDays !== undefined && monitor.type !== 'ssl_expiry') {
    problems.push({
      field: 'config/warnDays',
      message: `is not allowed for a ${monitor.type} monitor`,
    });
  }

  return problems;
}

function assertValid(monitor: Checkable): void {
  const problems = problemsOf(monitor);
  if (problems.length > 0) {
    throw new InvalidMonitorInputError(problems);
  }
}

function sameConfig(a: MonitorConfig, b: MonitorConfig): boolean {
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(([key, value]) => (b as Record<string, unknown>)[key] === value)
  );
}

export interface UpdateOutcome {
  monitor: MonitorEntity;
  /** True when the patch changes a stored value. */
  changed: boolean;
  before: MonitorDerivedState | null;
  after: MonitorDerivedState | null;
}

export default function monitorDomain() {
  return {
    createMonitor: (
      orgId: string,
      create: CreateMonitorProps,
    ): MonitorEntity => {
      const now = new Date();
      const monitor: MonitorEntity = {
        id: randomUUID(),
        orgId,
        serviceId: create.serviceId,
        type: create.type,
        name: create.name,
        target: create.target,
        intervalSeconds:
          create.intervalSeconds ?? MONITOR_LIMITS.intervalSeconds.default,
        timeoutSeconds:
          create.timeoutSeconds ?? MONITOR_LIMITS.timeoutSeconds.default,
        enabled: create.enabled ?? MONITOR_DEFAULT_ENABLED,
        failureThreshold:
          create.failureThreshold ?? MONITOR_LIMITS.failureThreshold.default,
        config: create.config ?? {},
        consecutiveFailures: 0,
        failureEpisode: 0,
        lastCheckedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      assertValid(monitor);
      return monitor;
    },

    /**
     * Applies a patch to the locked row and works out what it did to derived
     * state. An absent key is left alone and `config` replaces the stored
     * object whole. Re-enabling resets the counters first, then both states
     * are computed, so re-enable plus a threshold change ends at null.
     * `failureEpisode` is never reset, and grows when the edit enters
     * `failing`.
     */
    applyUpdate: (
      current: MonitorEntity,
      patch: UpdateMonitorProps,
    ): UpdateOutcome => {
      const next: MonitorEntity = {
        ...current,
        name: patch.name ?? current.name,
        target: patch.target ?? current.target,
        intervalSeconds: patch.intervalSeconds ?? current.intervalSeconds,
        timeoutSeconds: patch.timeoutSeconds ?? current.timeoutSeconds,
        failureThreshold: patch.failureThreshold ?? current.failureThreshold,
        enabled: patch.enabled ?? current.enabled,
        config: patch.config ?? current.config,
      };
      assertValid(next);

      if (!current.enabled && next.enabled) {
        next.consecutiveFailures = 0;
        next.lastCheckedAt = null;
      }

      const before = monitorStateOf(current);
      const after = monitorStateOf(next);
      if (after === 'failing' && before !== 'failing') {
        next.failureEpisode = current.failureEpisode + 1;
      }

      // `*.updated` announces a change, never an attempt: a patch that restates
      // the stored values writes and emits nothing.
      const changed =
        next.name !== current.name ||
        next.target !== current.target ||
        next.intervalSeconds !== current.intervalSeconds ||
        next.timeoutSeconds !== current.timeoutSeconds ||
        next.failureThreshold !== current.failureThreshold ||
        next.enabled !== current.enabled ||
        !sameConfig(next.config, current.config);
      if (changed) {
        next.updatedAt = new Date();
      }
      return { monitor: next, changed, before, after };
    },
  };
}
