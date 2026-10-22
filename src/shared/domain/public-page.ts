import {
  type IncidentImpact,
  type ServiceStatus,
  statusFromIncidentImpact,
  worstServiceStatus,
} from '@/shared/domain/status-inputs';

/**
 * What is public, and the status the page leads with, transcribed from
 * DOMAIN.md, "Public status page". Both rules are written once here. The
 * listing rule decides what the public page, its live stream (Epic 4's public
 * event gate), the Atom feed and subscriber emails may say, so none of them
 * keeps a copy (ARCHITECTURE 5.6). Its SQL half, how a query computes
 * `visible` and which timeline entries are public, is in
 * `src/shared/db/public-page-sql.ts`.
 */

/** A service an incident or window names, and whether it may be published. */
export type AffectedService = {
  serviceId: string;
  /**
   * `is_public` and not archived, computed by `visibleService` in
   * `src/shared/db/public-page-sql.ts`: the only services the page lists and
   * the feed and emails may name.
   */
  visible: boolean;
};

/** An item as the page publishes it: affected services reduced to visible ids. */
export type Published<T extends { affectedServices: AffectedService[] }> = Omit<
  T,
  'affectedServices'
> & { affectedServiceIds: string[] };

/**
 * The incidents or windows that may be published, in the order given: the
 * ones the page lists, and the only ones the feed and emails may speak of.
 *
 * One naming no service is listed: blast radius is often unknown at first. One
 * naming at least one visible service is listed with only those. One naming
 * only services that are not visible is left off, since it describes
 * components the organization chose not to publish. A hidden service's id is
 * never published, even beside a visible one.
 */
export function publishable<T extends { affectedServices: AffectedService[] }>(
  items: readonly T[],
): Published<T>[] {
  const published: Published<T>[] = [];

  for (const { affectedServices, ...item } of items) {
    const visibleIds = affectedServices
      .filter((service) => service.visible)
      .map((service) => service.serviceId);

    if (affectedServices.length > 0 && visibleIds.length === 0) {
      continue;
    }

    published.push({ ...item, affectedServiceIds: visibleIds });
  }

  return published;
}

/**
 * The banner: the worst of the visible services' statuses and of the listed
 * incidents' headline impact, by DOMAIN's impact mapping. Pass only what the
 * page lists; an incident left off must not raise the banner by the back door.
 */
export function overallStatus(
  services: readonly { status: ServiceStatus }[],
  listedIncidents: readonly { impact: IncidentImpact }[],
): ServiceStatus {
  return worstServiceStatus([
    ...services.map((service) => service.status),
    ...listedIncidents.map((incident) =>
      statusFromIncidentImpact(incident.impact),
    ),
  ]);
}
