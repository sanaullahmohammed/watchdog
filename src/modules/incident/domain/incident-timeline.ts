import type {
  IncidentStatus,
  IncidentStatusOrNew,
} from '@/modules/incident/domain/incident.types';

/**
 * The timeline entry a declaration or transition writes when the operator
 * gives no message of their own.
 *
 * DOMAIN.md requires every transition, the declaration included, to append a
 * timeline entry, and `message` is not null, so a status change always says
 * something. Worded for customers, because the timeline is what they read.
 *
 * A dismissed draft is worded as a dismissal, never as a resolution: it
 * describes an outage that never happened. See ARCHITECTURE.md section 5.4.
 */
export function timelineMessageFor(
  from: IncidentStatusOrNew,
  to: IncidentStatus,
): string {
  if (from === 'draft') {
    return to === 'resolved'
      ? 'Dismissed: this alert did not describe a real incident.'
      : 'Confirmed: we are investigating this issue.';
  }

  switch (to) {
    case 'draft':
      return 'Opened as a draft from a monitoring alert.';
    case 'investigating':
      return 'We are investigating this issue.';
    case 'identified':
      return 'The cause has been identified and a fix is being worked on.';
    case 'monitoring':
      return 'A fix has been applied and we are monitoring the results.';
    case 'resolved':
      return 'This incident has been resolved.';
  }
}

/**
 * The operator's message when they gave one, otherwise the default. Blank
 * counts as none: GraphQL cannot express a minimum length, and an empty entry
 * on a customer-facing timeline says nothing while looking like it says
 * something.
 */
export function timelineEntryMessage(
  given: string | null | undefined,
  from: IncidentStatusOrNew,
  to: IncidentStatus,
): string {
  return given?.trim() ? given : timelineMessageFor(from, to);
}
