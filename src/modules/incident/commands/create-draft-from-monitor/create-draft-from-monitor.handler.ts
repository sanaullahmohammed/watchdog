import { incidentActionCreator } from '@/modules/incident';
import { timelineEntryMessage } from '@/modules/incident/domain/incident-timeline';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentDraftCreatedEvent } from '@/shared/events/incident.events';
import { ArgumentInvalidException } from '@/shared/exceptions';
import { assertUuid } from '@/shared/validation/typebox-guard';

/** The new incident's id, or null when one already exists. */
export type CreateDraftFromMonitorCommandResult = Promise<string | null>;

export type CreateDraftFromMonitorCommandPayload = {
  orgId: string;
  monitorId: string;
  serviceId: string;
  monitorName: string;
  failureEpisode: number;
};

/** System command: proposes a draft for a monitor's failure episode. */
export const createDraftFromMonitorCommand =
  incidentActionCreator<CreateDraftFromMonitorCommandPayload>(
    'draft.create_from_monitor',
  );

export default function makeCreateDraftFromMonitor({
  incidentRepository,
  incidentDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof createDraftFromMonitorCommand
    >): CreateDraftFromMonitorCommandResult {
      const { orgId, monitorId, serviceId, monitorName, failureEpisode } =
        payload;
      assertUuid(monitorId, 'monitorId');
      assertUuid(serviceId, 'serviceId');
      if (!Number.isInteger(failureEpisode) || failureEpisode < 1) {
        throw new ArgumentInvalidException(
          'Invalid input. failureEpisode: must be an integer of at least 1',
        );
      }

      if (
        typeof monitorName !== 'string' ||
        monitorName.length < 1 ||
        monitorName.length > 183
      ) {
        throw new ArgumentInvalidException(
          'Invalid input. monitorName: must be 1 to 183 characters',
        );
      }

      const incident = incidentDomain.proposeDraft(orgId, {
        monitorId,
        serviceId,
        monitorName,
        failureEpisode,
      });

      const created = await withTenantTransaction(orgId, async (tx) => {
        if (!(await incidentRepository.insertDraftIfAbsent(tx, incident))) {
          return false;
        }
        await incidentRepository.appendUpdate(tx, {
          orgId,
          incidentId: incident.id,
          status: 'draft',
          message: timelineEntryMessage(null, null, 'draft'),
          createdByUserId: null,
        });
        return true;
      });
      if (!created) return null;

      // Only draft_created: the draft is not declared, and nothing was posted.
      eventBus.emit(
        incidentDraftCreatedEvent({
          id: incident.id,
          orgId,
          originMonitorId: monitorId,
          originFailureEpisode: failureEpisode,
        }),
      );
      return incident.id;
    },
    init() {
      commandBus.register(createDraftFromMonitorCommand.type, this.handler);
    },
  };
}
