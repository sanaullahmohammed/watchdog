import type { IncidentRepository } from '@/modules/incident/database/incident.repository.port';
import type { IncidentEntity } from '@/modules/incident/domain/incident.domain';
import { UnknownAffectedServiceError } from '@/modules/incident/domain/incident.errors';
import type { IncidentImpact } from '@/modules/incident/domain/incident.types';
import type { IncidentModel } from '@/modules/incident/incident.mapper';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

const FOREIGN_KEY_VIOLATION = '23503';

export default function incidentRepository({
  incidentMapper,
}: Dependencies): IncidentRepository {
  return {
    async insert(tx: TenantTransaction, incident: IncidentEntity) {
      await tx.sql`
        insert into incidents (
          id, org_id, title, status, impact, started_at, resolved_at,
          created_by_user_id, origin_monitor_id, source, created_at, updated_at
        ) values (
          ${incident.id}, ${incident.orgId}, ${incident.title},
          ${incident.status}, ${incident.impact}, ${incident.startedAt},
          ${incident.resolvedAt}, ${incident.createdByUserId},
          ${incident.originMonitorId}, ${incident.source},
          ${incident.createdAt}, ${incident.updatedAt}
        )
      `;

      if (incident.affectedServices.length === 0) {
        return;
      }

      try {
        await tx.sql`
          insert into incident_service_impacts ${tx.sql(
            incident.affectedServices.map((affected) => ({
              org_id: incident.orgId,
              incident_id: incident.id,
              service_id: affected.serviceId,
              impact: affected.impact,
            })),
          )}
        `;
      } catch (error) {
        // The service key spans (service_id, org_id), so naming another
        // organization's service fails here rather than silently attaching it.
        if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new UnknownAffectedServiceError(error as Error);
        }
        throw error;
      }
    },

    async findById(tx: TenantTransaction, id: string) {
      const rows = await tx.sql<IncidentModel[]>`
        select * from incidents where id = ${id} limit 1
      `;
      if (!rows[0]) return undefined;

      const impacts = await tx.sql<
        { service_id: string; impact: IncidentImpact }[]
      >`
        select service_id, impact from incident_service_impacts
        where incident_id = ${id}
        order by service_id
      `;

      return incidentMapper.toDomain(
        rows[0],
        impacts.map((row) => ({
          serviceId: row.service_id,
          impact: row.impact,
        })),
      );
    },
  };
}
