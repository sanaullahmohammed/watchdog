import {
  type IncidentImpact,
  type ServiceStatus,
  statusFromIncidentImpact,
  worstServiceStatus,
} from '@/shared/domain/status-inputs';

/**
 * What the public page shows and the status it leads with, transcribed from
 * DOMAIN.md, "Public status page". Both rules are written once here, and
 * DOMAIN requires Epic 4's public event gate to apply the listing rule too.
 */

/** A service an incident or window names, and whether the page may show it. */
export type AffectedService = {
  serviceId: string;
  /** `is_public` and not archived: the only services the page lists. */
  visible: boolean;
};

/** An item as the page publishes it: affected services reduced to visible ids. */
export type Published<T extends { affectedServices: AffectedService[] }> = Omit<
  T,
  'affectedServices'
> & { affectedServiceIds: string[] };

/**
 * The incidents or windows the page lists, in the order given.
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
