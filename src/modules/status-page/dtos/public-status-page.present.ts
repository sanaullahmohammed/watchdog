import type {
  PublicServiceRow,
  PublicUptimeRow,
} from '@/modules/status-page/database/public-status.repository';
import { overallStatus } from '@/modules/status-page/domain/public-page';
import {
  type PublicStatusPageResponseDto,
  UPTIME_WINDOW_DAYS,
} from '@/modules/status-page/dtos/public-status-page.response.dto';
import type { PublicStatusPageView } from '@/modules/status-page/queries/get-public-status-page/get-public-status-page.handler';

/**
 * One presenter for both surfaces, as every other module read has. The parity
 * contract compares the request shapes, never the responses, so two hand-written
 * mappings would be free to drift (Epic 2 retrospective, AV-4).
 */
export function toPublicStatusPage({
  organization,
  services,
  incidents,
  maintenance,
  uptime,
  generatedAt,
}: PublicStatusPageView): PublicStatusPageResponseDto {
  return {
    organization: { name: organization.name, slug: organization.slug },
    overallStatus: overallStatus(services, incidents),
    generatedAt: generatedAt.toISOString(),
    groups: groupServices(services),
    activeIncidents: incidents.map((incident) => ({
      id: incident.id,
      title: incident.title,
      impact: incident.impact,
      status: incident.status,
      startedAt: incident.startedAt.toISOString(),
      affectedServiceIds: incident.affectedServiceIds,
      updates: incident.updates.map((update) => ({
        id: update.id,
        status: update.status,
        message: update.message,
        createdAt: update.createdAt.toISOString(),
      })),
    })),
    maintenance: maintenance.map((window) => ({
      id: window.id,
      title: window.title,
      description: window.description,
      status: window.status,
      scheduledStartAt: window.scheduledStartAt.toISOString(),
      scheduledEndAt: window.scheduledEndAt.toISOString(),
      startedAt: window.startedAt?.toISOString() ?? null,
      affectedServiceIds: window.affectedServiceIds,
    })),
    uptime: {
      windowDays: UPTIME_WINDOW_DAYS,
      services: groupUptime(services, uptime),
    },
  };
}

/**
 * Nests services under their group, keeping the order the query returned:
 * groups by display order then name, services the same way inside one, and the
 * ungrouped bucket last. A renderer sorts nothing.
 */
function groupServices(
  services: PublicServiceRow[],
): PublicStatusPageResponseDto['groups'] {
  const groups: PublicStatusPageResponseDto['groups'] = [];
  const byId = new Map<string | null, number>();

  for (const service of services) {
    let index = byId.get(service.groupId);
    if (index === undefined) {
      index =
        groups.push({
          id: service.groupId,
          name: service.groupName,
          displayOrder: service.groupDisplayOrder,
          services: [],
        }) - 1;
      byId.set(service.groupId, index);
    }

    groups[index].services.push({
      id: service.id,
      name: service.name,
      description: service.description,
      status: service.status,
      displayOrder: service.displayOrder,
    });
  }

  return groups;
}

/**
 * Uptime for the services that have any, in the services list's order. The
 * rows arrive grouped by service and oldest day first; this never re-sorts.
 */
function groupUptime(
  services: PublicServiceRow[],
  rows: PublicUptimeRow[],
): PublicStatusPageResponseDto['uptime']['services'] {
  const byService = new Map<string, PublicUptimeRow[]>();
  for (const row of rows) {
    const days = byService.get(row.serviceId);
    if (days) {
      days.push(row);
    } else {
      byService.set(row.serviceId, [row]);
    }
  }

  return services.flatMap((service) => {
    const days = byService.get(service.id);
    return days
      ? [
          {
            serviceId: service.id,
            days: days.map((day) => ({
              date: day.date,
              uptimeRatio: day.uptimeRatio,
              worstStatus: day.worstStatus,
            })),
          },
        ]
      : [];
  });
}
