import type { AffectedService } from '@/modules/status-page/domain/public-page';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import {
  ACTIVE_INCIDENT_STATUSES,
  type IncidentImpact,
  type IncidentStatus,
  type MaintenanceStatus,
  type ServiceStatus,
} from '@/shared/domain/status-inputs';

export type PublicServiceRow = {
  id: string;
  name: string;
  description: string | null;
  status: ServiceStatus;
  displayOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupDisplayOrder: number | null;
};

export type PublicIncidentRow = {
  id: string;
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  startedAt: Date;
  /** Every service named, visible or not. `publishable` decides what shows. */
  affectedServices: AffectedService[];
  updates: {
    id: string;
    status: IncidentStatus;
    message: string;
    createdAt: Date;
  }[];
};

export type PublicMaintenanceRow = {
  id: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  startedAt: Date | null;
  /** Every service named, visible or not. `publishable` decides what shows. */
  affectedServices: AffectedService[];
};

/**
 * Everything one page is built from, read together under one transaction.
 * Incidents and windows arrive unfiltered by the services they name: which of
 * them the page lists is DOMAIN's rule, applied once in `publishable`.
 */
export type PublicStatusReads = {
  services: PublicServiceRow[];
  incidents: PublicIncidentRow[];
  maintenance: PublicMaintenanceRow[];
};

/** What is happening or about to. A completed window is history. */
const OPEN_MAINTENANCE_STATUSES = ['scheduled', 'in_progress'] as const;

/**
 * The public page's reads, all under one tenant transaction.
 *
 * These are the services, incidents and maintenance tables, which belong to
 * three other modules. Modules may not import one another, so this reads their
 * tables directly, the same shape story 2.17's status recomputation uses — and
 * with the same cost the Epic 2 retrospective recorded (AV-2): a dependency on
 * their schemas that no structural rule can see. It is stated in the epic, and
 * again here, because the alternative is discovering it from a broken query.
 */
export default function publicStatusRepository() {
  return {
    /**
     * Public, non-archived services with the group each belongs to, already in
     * the order the page shows them: groups by display order then name,
     * services the same way inside a group, and ungrouped services last.
     *
     * Each ends at its id, because names are not unique. Without `g.id`, two
     * groups tied on display order and name had their rows interleaved by the
     * service columns, so which group came first depended on its services.
     * Without `s.id`, two services tied on both could swap between requests.
     * (Epic 3 retrospective, R-13.)
     *
     * `nulls last` is what puts that ungrouped bucket at the end. Both group
     * columns are not null, so a null one here means the left join matched no
     * group. An explicit `(g.id is null) asc` ahead of them sorted nothing they
     * did not already sort - no sabotage of it could make a test fail - so it
     * is not there.
     */
    async listPublicServices(
      tx: TenantTransaction,
    ): Promise<PublicServiceRow[]> {
      const rows = await tx.sql<
        {
          id: string;
          name: string;
          description: string | null;
          last_known_status: ServiceStatus;
          display_order: number;
          group_id: string | null;
          group_name: string | null;
          group_display_order: number | null;
        }[]
      >`
        select
          s.id, s.name, s.description, s.last_known_status,
          s.display_order,
          g.id as group_id, g.name as group_name,
          g.display_order as group_display_order
        from services s
        left join service_groups g
          on g.id = s.service_group_id and g.org_id = s.org_id
        where s.archived_at is null and s.is_public = true
        order by
          g.display_order asc nulls last, g.name asc nulls last,
          g.id asc nulls last,
          s.display_order asc, s.name asc, s.id asc
      `;

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        // Read, never recomputed: the recomputation handler keeps this current,
        // and a public read that recomputed would do it on every request.
        status: row.last_known_status,
        displayOrder: row.display_order,
        groupId: row.group_id,
        groupName: row.group_name,
        groupDisplayOrder: row.group_display_order,
      }));
    },

    async listActiveIncidents(
      tx: TenantTransaction,
    ): Promise<PublicIncidentRow[]> {
      const incidents = await tx.sql<
        {
          id: string;
          title: string;
          impact: IncidentImpact;
          status: IncidentStatus;
          started_at: Date;
        }[]
      >`
        select id, title, impact, status, started_at
        from incidents
        where status in ${tx.sql(ACTIVE_INCIDENT_STATUSES)}
        order by started_at desc, id desc
      `;

      if (incidents.length === 0) {
        return [];
      }

      const ids = incidents.map((incident) => incident.id);

      // Visible is the services query's own predicate. A link to a service
      // that is private or archived is still returned, so the rule can tell an
      // incident naming only hidden services from one naming none.
      const impacts = await tx.sql<
        { incident_id: string; service_id: string; visible: boolean }[]
      >`
        select isi.incident_id, isi.service_id,
               (s.is_public and s.archived_at is null) as visible
        from incident_service_impacts isi
        join services s on s.id = isi.service_id and s.org_id = isi.org_id
        where isi.incident_id in ${tx.sql(ids)}
        order by isi.service_id asc
      `;

      const updates = await tx.sql<
        {
          incident_id: string;
          id: string;
          status: IncidentStatus;
          message: string;
          created_at: Date;
        }[]
      >`
        select incident_id, id, status, message, created_at
        from incident_updates
        where incident_id in ${tx.sql(ids)}
          -- Entries from the incident's draft era were never public: a draft
          -- was not shown to customers, and nor were the notes posted to it.
          -- DOMAIN, "Public status page"; Epic 3 retrospective, R-4.
          and status <> 'draft'
        order by created_at asc, id asc
      `;

      return incidents.map((incident) => ({
        id: incident.id,
        title: incident.title,
        impact: incident.impact,
        status: incident.status,
        startedAt: incident.started_at,
        affectedServices: impacts
          .filter((row) => row.incident_id === incident.id)
          .map((row) => ({ serviceId: row.service_id, visible: row.visible })),
        updates: updates
          .filter((row) => row.incident_id === incident.id)
          .map((row) => ({
            id: row.id,
            status: row.status,
            message: row.message,
            createdAt: row.created_at,
          })),
      }));
    },

    async listOpenMaintenance(
      tx: TenantTransaction,
    ): Promise<PublicMaintenanceRow[]> {
      const windows = await tx.sql<
        {
          id: string;
          title: string;
          description: string | null;
          status: MaintenanceStatus;
          scheduled_start_at: Date;
          scheduled_end_at: Date;
          started_at: Date | null;
        }[]
      >`
        select id, title, description, status,
               scheduled_start_at, scheduled_end_at, started_at
        from maintenance
        where status in ${tx.sql(OPEN_MAINTENANCE_STATUSES)}
        order by scheduled_start_at asc, id asc
      `;

      if (windows.length === 0) {
        return [];
      }

      const affected = await tx.sql<
        { maintenance_id: string; service_id: string; visible: boolean }[]
      >`
        select ms.maintenance_id, ms.service_id,
               (s.is_public and s.archived_at is null) as visible
        from maintenance_services ms
        join services s on s.id = ms.service_id and s.org_id = ms.org_id
        where ms.maintenance_id in ${tx.sql(windows.map((window) => window.id))}
        order by ms.service_id asc
      `;

      return windows.map((window) => ({
        id: window.id,
        title: window.title,
        description: window.description,
        status: window.status,
        scheduledStartAt: window.scheduled_start_at,
        scheduledEndAt: window.scheduled_end_at,
        startedAt: window.started_at,
        affectedServices: affected
          .filter((row) => row.maintenance_id === window.id)
          .map((row) => ({ serviceId: row.service_id, visible: row.visible })),
      }));
    },
  };
}
