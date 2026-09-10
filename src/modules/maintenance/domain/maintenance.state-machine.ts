import type { MaintenanceStatus } from '@/modules/maintenance/domain/maintenance.types';
import { ArgumentInvalidException } from '@/shared/exceptions';

/**
 * The maintenance lifecycle, transcribed from DOMAIN.md's transition table.
 *
 * `null` is DOMAIN's `[none]`: a window is always created `scheduled`.
 *
 * Both `scheduled -> completed` and `in_progress -> completed` appear twice in
 * that table, once triggered by the worker and once by a human. The legality is
 * the same either way, so the actor is not part of the key; what differs is who
 * calls it and which event announces it.
 */
export type MaintenanceStatusOrNew = MaintenanceStatus | null;

const ALLOWED_TRANSITIONS: ReadonlyArray<
  readonly [MaintenanceStatusOrNew, MaintenanceStatus]
> = [
  [null, 'scheduled'],
  ['scheduled', 'in_progress'], // worker: start time reached
  ['scheduled', 'completed'], // worker: end passed before start ran; or human cancels
  ['in_progress', 'completed'], // worker: end reached; or human completes early
];

export class InvalidMaintenanceTransitionError extends ArgumentInvalidException {
  constructor(from: MaintenanceStatusOrNew, to: MaintenanceStatus) {
    super(
      `A maintenance window cannot move from ${from ?? '[none]'} to ${to}. ` +
        'See DOMAIN.md, Maintenance state machine.',
    );
  }
}

export function canTransition(
  from: MaintenanceStatusOrNew,
  to: MaintenanceStatus,
): boolean {
  return ALLOWED_TRANSITIONS.some(
    ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
  );
}

export function assertTransition(
  from: MaintenanceStatusOrNew,
  to: MaintenanceStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidMaintenanceTransitionError(from, to);
  }
}

export function allowedTransitions() {
  return ALLOWED_TRANSITIONS;
}
