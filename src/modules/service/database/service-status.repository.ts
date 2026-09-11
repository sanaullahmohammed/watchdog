import type { ServiceStatus } from '@/modules/service/domain/service.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import type { IncidentImpact } from '@/shared/domain/status-inputs';

/** One live service and everything its effective status is computed from. */
export type LiveServiceStatusInputs = {
  id: string;
  orgId: string;
  slug: string;
  manualOverride: ServiceStatus | null;
  lastKnownStatus: ServiceStatus;
  activeIncidentImpacts: IncidentImpact[];
  hasActiveMaintenance: boolean;
};

/**
 * The status recomputation handler's reads and its one write.
 *
 * It reads the incident and maintenance tables directly. That is a read of
 * data, not an import of another module's code, and it is the only way to
 * gather the inputs without a module calling across a boundary; DOMAIN.md's
 * Status recomputation section records why the service module owns this.
 */
export default function serviceStatusRepository() {
  return {
    /**
     * Locks the organization's live services, then reads every input to their
     * effective status.
     *
     * The lock comes first so concurrent recomputations of one organization
     * queue behind each other, and each reads inputs committed before it got
     * the lock. `for no key update` rather than `for update`: an insert whose
     * foreign-key check takes `for key share` on a service, such as naming it
     * on an incident, does not have to wait.
     */
    async lockLiveServiceInputs(
      tx: TenantTransaction,
    ): Promise<LiveServiceStatusInputs[]> {
      const services = await tx.sql<
        {
          id: string;
          org_id: string;
          slug: string;
          manual_status_override: ServiceStatus | null;
          last_known_status: ServiceStatus;
        }[]
      >`
        select id, org_id, slug, manual_status_override, last_known_status
        from services
        where archived_at is null
        order by id
        for no key update
      `;
      if (services.length === 0) return [];

      // The per-service impact, not the incident's headline one. Drafts were
      // never shown to customers and resolved incidents are over.
      const impacts = await tx.sql<
        { service_id: string; impact: IncidentImpact }[]
      >`
        select isi.service_id, isi.impact
        from incident_service_impacts isi
        join incidents i on i.id = isi.incident_id and i.org_id = isi.org_id
        where i.status in ('investigating', 'identified', 'monitoring')
      `;

      const underMaintenance = await tx.sql<{ service_id: string }[]>`
        select distinct ms.service_id
        from maintenance_services ms
        join maintenance m on m.id = ms.maintenance_id and m.org_id = ms.org_id
        where m.status = 'in_progress'
      `;
      const maintained = new Set(underMaintenance.map((row) => row.service_id));

      return services.map((service) => ({
        id: service.id,
        orgId: service.org_id,
        slug: service.slug,
        manualOverride: service.manual_status_override,
        lastKnownStatus: service.last_known_status,
        activeIncidentImpacts: impacts
          .filter((row) => row.service_id === service.id)
          .map((row) => row.impact),
        hasActiveMaintenance: maintained.has(service.id),
      }));
    },

    /**
     * `updated_at` is left alone: it records edits someone made, and this is a
     * derived value moving underneath them.
     */
    async writeLastKnownStatus(
      tx: TenantTransaction,
      id: string,
      status: ServiceStatus,
    ): Promise<void> {
      await tx.sql`
        update services set last_known_status = ${status} where id = ${id}
      `;
    },
  };
}
