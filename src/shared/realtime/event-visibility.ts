/**
 * Which bridged events may reach a public subscriber: DOMAIN.md's catalog,
 * its "Public" and "Public, draft-gated" rows, which is ARCHITECTURE.md 5.4's
 * `PUBLIC_EVENT_NAMES`.
 *
 * Necessary, not sufficient. A name on this list only lets the api consider
 * the organization's public page again (story 4.6); the page itself applies
 * DOMAIN's visibility rule, draft gating included. A name off this list never
 * reaches the public path at all, not even as timing.
 *
 * Pure: the unit suite checks it against the restated catalog.
 */
export const PUBLIC_EVENT_NAMES: ReadonlySet<string> = new Set([
  'service.status_changed',
  'service.created',
  'service.updated',
  'service.archived',
  'service.restored',
  'service_group.created',
  'service_group.updated',
  'service_group.deleted',
  'incident.created',
  'incident.confirmed',
  'incident.updated',
  'incident.update_posted',
  'incident.resolved',
  'maintenance.created',
  'maintenance.updated',
  'maintenance.started',
  'maintenance.completed',
  'maintenance.deleted',
]);

export function isPublicEvent(name: string): boolean {
  return PUBLIC_EVENT_NAMES.has(name);
}
