import type { NotificationCursor } from '@/modules/notification/database/notification-cursor.repository';
import {
  publicTimelineEntry,
  visibleService,
} from '@/shared/db/public-page-sql';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import type { AffectedService } from '@/shared/domain/public-page';
import type { NotificationSourceType } from '@/shared/events/notification.events';

/** One incident timeline entry the pass scanned. */
export type ScannedIncidentEntry = {
  id: string;
  incidentId: string;
  /** The shared `publicTimelineEntry` predicate, judged on current rows. */
  public: boolean;
  /** `created_at` as text, so it reaches SQL again with its microseconds. */
  recordedAt: string;
};

export type MaintenanceSourceType = Exclude<
  NotificationSourceType,
  'incident_update'
>;

/** One maintenance change the pass scanned: a window's own timestamp. */
export type ScannedMaintenanceChange = {
  maintenanceId: string;
  sourceType: MaintenanceSourceType;
  /** The timestamp as text, so it reaches SQL again with its microseconds. */
  recordedAt: string;
};

/** A scan, and the furthest position it reached, null when it found nothing. */
export type Scan<T> = { rows: T[]; through: string | null };

/**
 * The durable history of public changes the notification pass reads: other
 * modules' tables, each on the foreign-table allowlist, as the status page
 * reads them. Takes a `TenantTransaction` per call.
 *
 * Each read covers what was recorded after the cursor, plus everything
 * recorded within the overlap before the previous read: `sequence` is insert
 * order, not commit order, and a window's timestamp is stamped before its
 * transaction commits, so a change can become visible after a later one was
 * read. A cursor that has never read has no overlap branch, so its first pass
 * reads the whole history.
 */
export default function publicHistoryRepository() {
  return {
    /**
     * Every timeline entry past the cursor or inside the overlap, public or
     * not, in sequence order. `through` is the highest sequence scanned.
     */
    async scanIncidentEntries(
      tx: TenantTransaction,
      cursor: NotificationCursor,
      overlapSeconds: number,
    ): Promise<Scan<ScannedIncidentEntry>> {
      const rows = await tx.sql<
        {
          id: string;
          incident_id: string;
          public: boolean;
          recorded_at: string;
          through: string;
        }[]
      >`
        select
          iu.id,
          iu.incident_id,
          ${publicTimelineEntry(tx, 'iu')} as public,
          iu.created_at::text as recorded_at,
          (max(iu.sequence) over ())::text as through
        from incident_updates iu
        where iu.sequence > ${cursor.incidentUpdateSequence}::text::bigint
          or iu.created_at >= ${cursor.readAt}::text::timestamptz
            - make_interval(secs => ${overlapSeconds})
        order by iu.sequence asc
      `;
      return {
        rows: rows.map((row) => ({
          id: row.id,
          incidentId: row.incident_id,
          public: row.public,
          recordedAt: row.recorded_at,
        })),
        through: rows[0]?.through ?? null,
      };
    },

    /**
     * Every maintenance change past the cursor or inside the overlap. Each of
     * a window's three timestamps is its own change and is filtered on its
     * own, so a window read for one does not bring back the others. A window
     * deleted before the pass is not here at all. `through` is the latest
     * timestamp scanned.
     */
    async scanMaintenanceChanges(
      tx: TenantTransaction,
      cursor: NotificationCursor,
      overlapSeconds: number,
    ): Promise<Scan<ScannedMaintenanceChange>> {
      const rows = await tx.sql<
        {
          maintenance_id: string;
          source_type: MaintenanceSourceType;
          recorded_at: string;
          through: string;
        }[]
      >`
        select
          m.id as maintenance_id,
          k.source_type,
          k.recorded_at::text as recorded_at,
          (max(k.recorded_at) over ())::text as through
        from maintenance m
        cross join lateral (
          values
            ('maintenance_scheduled', m.created_at),
            ('maintenance_started', m.started_at),
            ('maintenance_completed', m.completed_at)
        ) as k (source_type, recorded_at)
        where k.recorded_at > coalesce(
            ${cursor.maintenanceReadAt}::text::timestamptz, '-infinity'
          )
          or k.recorded_at >= ${cursor.readAt}::text::timestamptz
            - make_interval(secs => ${overlapSeconds})
        order by k.recorded_at asc, m.id asc, k.source_type asc
      `;
      return {
        rows: rows.map((row) => ({
          maintenanceId: row.maintenance_id,
          sourceType: row.source_type,
          recordedAt: row.recorded_at,
        })),
        through: rows[0]?.through ?? null,
      };
    },

    /**
     * Every service each incident names, visible or not, by the shared
     * predicate. `publishable` decides from these, as it does for the page.
     */
    async incidentServices(
      tx: TenantTransaction,
      incidentIds: readonly string[],
    ): Promise<Map<string, AffectedService[]>> {
      if (incidentIds.length === 0) return new Map();
      const rows = await tx.sql<
        { incident_id: string; service_id: string; visible: boolean }[]
      >`
        select isi.incident_id, isi.service_id,
               ${visibleService(tx, 's')} as visible
        from incident_service_impacts isi
        join services s on s.id = isi.service_id and s.org_id = isi.org_id
        where isi.incident_id in ${tx.sql(incidentIds)}
        order by isi.service_id asc
      `;
      return groupServices(
        rows.map((row) => ({ ownerId: row.incident_id, ...row })),
      );
    },

    /** Every service each window names, visible or not. */
    async maintenanceServices(
      tx: TenantTransaction,
      maintenanceIds: readonly string[],
    ): Promise<Map<string, AffectedService[]>> {
      if (maintenanceIds.length === 0) return new Map();
      const rows = await tx.sql<
        { maintenance_id: string; service_id: string; visible: boolean }[]
      >`
        select ms.maintenance_id, ms.service_id,
               ${visibleService(tx, 's')} as visible
        from maintenance_services ms
        join services s on s.id = ms.service_id and s.org_id = ms.org_id
        where ms.maintenance_id in ${tx.sql(maintenanceIds)}
        order by ms.service_id asc
      `;
      return groupServices(
        rows.map((row) => ({ ownerId: row.maintenance_id, ...row })),
      );
    },
  };
}

function groupServices(
  rows: readonly { ownerId: string; service_id: string; visible: boolean }[],
): Map<string, AffectedService[]> {
  const grouped = new Map<string, AffectedService[]>();
  for (const row of rows) {
    const services = grouped.get(row.ownerId) ?? [];
    services.push({ serviceId: row.service_id, visible: row.visible });
    grouped.set(row.ownerId, services);
  }
  return grouped;
}
