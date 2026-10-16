import { actionCreatorFactory } from '@/shared/cqrs/action-creator';
import type { MonitorDerivedState } from '@/shared/domain/status-inputs';

/**
 * Monitor lifecycle events, from the canonical catalog in DOMAIN.md.
 *
 * Declared in `shared` because they cross module boundaries: the service
 * module recomputes status on `state_changed`. Payloads are their own types.
 * Admin-only; none reaches the public surface.
 */
const monitorEventCreator = actionCreatorFactory('monitor');

export type MonitorEventPayload = {
  orgId: string;
  monitorId: string;
  serviceId: string;
  monitorName: string;
};

/** A monitor's derived state, or null when it contributes nothing. */
export type MonitorStatePayload = MonitorDerivedState | null;

export const monitorCreatedEvent =
  monitorEventCreator<MonitorEventPayload>('created');

export const monitorUpdatedEvent =
  monitorEventCreator<MonitorEventPayload>('updated');

/**
 * The monitor's derived state moved. `from` and `to` are the states before and
 * after, null meaning it contributed nothing. `failureEpisode` is the
 * monitor's episode after the change.
 */
export const monitorStateChangedEvent = monitorEventCreator<
  MonitorEventPayload & {
    from: MonitorStatePayload;
    to: MonitorStatePayload;
    failureEpisode: number;
  }
>('state_changed');

/** A check finished and succeeded. `checkedAt` is an ISO string. */
export const monitorCheckSucceededEvent = monitorEventCreator<
  MonitorEventPayload & { checkedAt: string }
>('check_succeeded');

/** A check finished and failed, with the adapter's `errorCode`. */
export const monitorCheckFailedEvent = monitorEventCreator<
  MonitorEventPayload & { checkedAt: string; errorCode: string }
>('check_failed');

/**
 * The monitor entered `failing`. `failureEpisode` is the new episode, which
 * the incident module keys a draft on.
 */
export const monitorThresholdBreachedEvent = monitorEventCreator<
  MonitorEventPayload & { failureEpisode: number }
>('threshold_breached');

/**
 * The monitor moved from `failing` to `healthy`. `failureEpisode` is the
 * episode that ended.
 */
export const monitorRecoveredEvent = monitorEventCreator<
  MonitorEventPayload & { failureEpisode: number }
>('recovered');
