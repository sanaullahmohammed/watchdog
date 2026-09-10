import {
  INCIDENT_STATUSES,
  type IncidentStatus,
  type IncidentStatusOrNew,
} from '@/modules/incident/domain/incident.types';
import { ArgumentInvalidException } from '@/shared/exceptions';

/**
 * The incident lifecycle, transcribed from DOMAIN.md's allowed-transition
 * table. One place decides legality so no call site re-derives it.
 *
 * `null` stands for DOMAIN's `[none]`: creation. A monitor-born incident is
 * created at `draft`; a human-declared one at `investigating`. Nothing else may
 * be a starting status.
 */
const ALLOWED_TRANSITIONS: ReadonlyArray<
  readonly [IncidentStatusOrNew, IncidentStatus]
> = [
  [null, 'draft'], // worker: consecutive monitor failures reach threshold
  [null, 'investigating'], // human: manual incident creation
  ['draft', 'investigating'], // human confirms a monitor-generated draft
  ['draft', 'resolved'], // human dismisses or closes a draft
  ['investigating', 'identified'],
  ['investigating', 'monitoring'],
  ['investigating', 'resolved'],
  ['identified', 'monitoring'],
  ['identified', 'resolved'],
  ['monitoring', 'resolved'],
];

export class InvalidIncidentTransitionError extends ArgumentInvalidException {
  constructor(from: IncidentStatusOrNew, to: IncidentStatus) {
    super(
      `An incident cannot move from ${from ?? '[none]'} to ${to}. ` +
        'See DOMAIN.md, Incident state machine.',
    );
  }
}

export function canTransition(
  from: IncidentStatusOrNew,
  to: IncidentStatus,
): boolean {
  return ALLOWED_TRANSITIONS.some(
    ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
  );
}

export function assertTransition(
  from: IncidentStatusOrNew,
  to: IncidentStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidIncidentTransitionError(from, to);
  }
}

/** Every legal transition, for exhaustive testing and documentation. */
export function allowedTransitions() {
  return ALLOWED_TRANSITIONS;
}

/** Every ordered pair the machine could be asked about, legal or not. */
export function allTransitionPairs(): ReadonlyArray<
  readonly [IncidentStatusOrNew, IncidentStatus]
> {
  const origins: IncidentStatusOrNew[] = [null, ...INCIDENT_STATUSES];
  return origins.flatMap((from) =>
    INCIDENT_STATUSES.map((to) => [from, to] as const),
  );
}

/**
 * Which event a move to `resolved` announces.
 *
 * Dismissing a draft and resolving a live incident both land on `resolved`,
 * because the ladder has no `dismissed` status. They are not the same thing:
 * a dismissed draft describes an outage that never happened, and customers
 * were never told about it. ARCHITECTURE.md section 5.4 reserves
 * `incident.resolved` for incidents that went through the public lifecycle,
 * so a draft dismissal must announce `incident.dismissed` instead.
 */
export function resolutionEventName(
  from: IncidentStatus,
): 'incident.dismissed' | 'incident.resolved' {
  return from === 'draft' ? 'incident.dismissed' : 'incident.resolved';
}
