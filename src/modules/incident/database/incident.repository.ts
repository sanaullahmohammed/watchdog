import type {
  IncidentRepository,
  ListIncidentsFilter,
} from '@/modules/incident/database/incident.repository.port';
import type {
  IncidentEntity,
  UpdateIncidentProps,
} from '@/modules/incident/domain/incident.domain';
import { UnknownAffectedServiceError } from '@/modules/incident/domain/incident.errors';
import type {
  IncidentImpact,
  IncidentStatus,
} from '@/modules/incident/domain/incident.types';
import type { IncidentModel } from '@/modules/incident/incident.mapper';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

const FOREIGN_KEY_VIOLATION = '23503';

export default function incidentRepository({
  incidentMapper,
}: Dependencies): IncidentRepository {
  return {
    async list(tx: TenantTransaction, filter: ListIncidentsFilter) {
      // Drafts are excluded unless explicitly asked for, and a public
      // composition excludes them whatever else was asked - the same
      // precedence services use for archived.
      const showDrafts = filter.includeDrafts === true && !filter.publicOnly;

      const rows = await tx.sql<IncidentModel[]>`
        select * from incidents
        where true
          ${showDrafts ? tx.sql`` : tx.sql`and status <> 'draft'`}
          ${filter.status ? tx.sql`and status = ${filter.status}` : tx.sql``}
        order by started_at desc, id desc
      `;
      return rows.map((row) => incidentMapper.toDomain(row));
    },

    async timeline(tx: TenantTransaction, incidentId: string) {
      // (created_at, id): entries written inside one transaction share a
      // timestamp, so id is what makes the order deterministic rather than
      // whatever the planner returns.
      const rows = await tx.sql<
        {
          id: string;
          status: IncidentStatus;
          message: string;
          created_at: Date;
        }[]
      >`
        select id, status, message, created_at from incident_updates
        where incident_id = ${incidentId}
        order by created_at asc, id asc
      `;
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        message: row.message,
        createdAt: row.created_at,
      }));
    },

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

    async updateStatus(
      tx: TenantTransaction,
      id: string,
      status: IncidentStatus,
    ) {
      // resolved_at is set on the way into `resolved` and cleared on no other
      // path, because `resolved` is terminal.
      const rows = await tx.sql<IncidentModel[]>`
        update incidents
        set status = ${status},
            resolved_at = ${status === 'resolved' ? tx.sql`now()` : tx.sql`resolved_at`},
            updated_at = now()
        where id = ${id}
        returning *
      `;
      return rows[0] ? incidentMapper.toDomain(rows[0]) : undefined;
    },

    async updateDetails(
      tx: TenantTransaction,
      id: string,
      patch: UpdateIncidentProps,
    ) {
      const columns: Record<string, unknown> = {};
      if (patch.title !== undefined) columns.title = patch.title;
      if (patch.impact !== undefined) columns.impact = patch.impact;

      if (Object.keys(columns).length === 0) {
        const current = await tx.sql<IncidentModel[]>`
          select * from incidents where id = ${id} limit 1
        `;
        return current[0] ? incidentMapper.toDomain(current[0]) : undefined;
      }

      columns.updated_at = new Date();

      const rows = await tx.sql<IncidentModel[]>`
        update incidents set ${tx.sql(columns)} where id = ${id} returning *
      `;
      return rows[0] ? incidentMapper.toDomain(rows[0]) : undefined;
    },

    async replaceAffectedServices(
      tx: TenantTransaction,
      incident: IncidentEntity,
      affected: { serviceId: string; impact: IncidentImpact }[],
    ) {
      await tx.sql`
        delete from incident_service_impacts where incident_id = ${incident.id}
      `;

      if (affected.length === 0) return;

      try {
        await tx.sql`
          insert into incident_service_impacts ${tx.sql(
            affected.map((entry) => ({
              org_id: incident.orgId,
              incident_id: incident.id,
              service_id: entry.serviceId,
              impact: entry.impact,
            })),
          )}
        `;
      } catch (error) {
        if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new UnknownAffectedServiceError(error as Error);
        }
        throw error;
      }
    },

    async appendUpdate(
      tx: TenantTransaction,
      entry: {
        orgId: string;
        incidentId: string;
        status: IncidentStatus;
        message: string;
        createdByUserId: string | null;
      },
    ) {
      const rows = await tx.sql<{ id: string }[]>`
        insert into incident_updates (
          org_id, incident_id, status, message, created_by_user_id
        ) values (
          ${entry.orgId}, ${entry.incidentId}, ${entry.status},
          ${entry.message}, ${entry.createdByUserId}
        )
        returning id
      `;
      return rows[0].id;
    },

    async findById(
      tx: TenantTransaction,
      id: string,
      options: { lock?: 'update' | 'share' } = {},
    ) {
      // Fixed fragments, never interpolated text. `no key update` rather than
      // `update`, so the foreign-key checks of timeline inserts, which take
      // `for key share`, are not blocked by a transition in progress.
      const lock =
        options.lock === 'update'
          ? tx.sql`for no key update`
          : options.lock === 'share'
            ? tx.sql`for share`
            : tx.sql``;
      const rows = await tx.sql<IncidentModel[]>`
        select * from incidents where id = ${id} limit 1 ${lock}
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
