import { env } from '@/config';
import { notificationActionCreator } from '@/modules/notification';
import type { OwedSource } from '@/modules/notification/database/delivery.repository';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { publishable } from '@/shared/domain/public-page';
import { notificationEmailQueuedEvent } from '@/shared/events/notification.events';

export type QueueEmailNotificationCommandResult = Promise<{ queued: number }>;

/**
 * One organization's notification pass: works out which confirmed subscribers
 * are owed each public change recorded since the cursor, and writes each one
 * `pending` delivery. Sending them is story 6.7. ARCHITECTURE 5.6.
 *
 * There is no route or resolver. This is the worker's command; see
 * ARCHITECTURE.md 6.0 for why discovery and work are separate steps.
 */
export const queueEmailNotificationCommand = notificationActionCreator<{
  orgId: string;
}>('queue_email_notification');

export default function makeQueueEmailNotification({
  notificationCursorRepository,
  publicHistoryRepository,
  subscriberRepository,
  deliveryRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof queueEmailNotificationCommand
    >): QueueEmailNotificationCommandResult {
      const overlapSeconds = env.notification.cursorOverlapSeconds;

      const queued = await withTenantTransaction(payload.orgId, async (tx) => {
        // 1. Passes for one organization run one after the other.
        const cursor = await notificationCursorRepository.lockForPass(tx);

        // 2. What was recorded since the cursor, and what each change names.
        const entries = await publicHistoryRepository.scanIncidentEntries(
          tx,
          cursor,
          overlapSeconds,
        );
        const changes = await publicHistoryRepository.scanMaintenanceChanges(
          tx,
          cursor,
          overlapSeconds,
        );
        const publicEntries = entries.rows.filter((entry) => entry.public);
        const incidentServices = await publicHistoryRepository.incidentServices(
          tx,
          [...new Set(publicEntries.map((entry) => entry.incidentId))],
        );
        const windowServices =
          await publicHistoryRepository.maintenanceServices(tx, [
            ...new Set(changes.rows.map((change) => change.maintenanceId)),
          ]);

        // 3. The shared rule, on current rows: a change about an incident or
        // window naming only hidden services is owed to no one.
        const sources: OwedSource[] = publishable([
          ...publicEntries.map((entry) => ({
            sourceType: 'incident_update' as const,
            sourceId: entry.id,
            recordedAt: entry.recordedAt,
            affectedServices: incidentServices.get(entry.incidentId) ?? [],
          })),
          ...changes.rows.map((change) => ({
            sourceType: change.sourceType,
            sourceId: change.maintenanceId,
            recordedAt: change.recordedAt,
            affectedServices: windowServices.get(change.maintenanceId) ?? [],
          })),
        ]).map(({ sourceType, sourceId, recordedAt }) => ({
          sourceType,
          sourceId,
          recordedAt,
        }));

        // 4 and 5. Only when something is owed: lock the confirmed
        // subscribers, then write what each is owed.
        let written: Awaited<
          ReturnType<typeof deliveryRepository.insertPending>
        > = [];
        if (sources.length > 0) {
          const subscriberIds = await subscriberRepository.lockConfirmed(tx);
          written = await deliveryRepository.insertPending(
            tx,
            sources,
            subscriberIds,
          );
        }

        // 6. Past every row scanned, public or not.
        await notificationCursorRepository.advance(tx, {
          incidentUpdateSequence: entries.through,
          maintenanceReadAt: changes.through,
        });
        return written;
      });

      // 7. After commit, so nothing announces a row a rollback undid. Ids
      // only: the address never travels in an event.
      for (const delivery of queued) {
        eventBus.emit(
          notificationEmailQueuedEvent({
            orgId: payload.orgId,
            deliveryId: delivery.id,
            subscriberId: delivery.subscriberId,
            sourceType: delivery.sourceType,
            sourceId: delivery.sourceId,
          }),
        );
      }

      return { queued: queued.length };
    },
    init() {
      commandBus.register(queueEmailNotificationCommand.type, this.handler);
    },
  };
}
