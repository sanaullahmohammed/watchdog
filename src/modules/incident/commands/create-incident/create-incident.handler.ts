import { incidentActionCreator } from '@/modules/incident';
import type { CreateIncidentProps } from '@/modules/incident/domain/incident.domain';
import { timelineEntryMessage } from '@/modules/incident/domain/incident-timeline';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentCreatedEvent } from '@/shared/events/incident.events';
import { assertNoDuplicates, parseDate } from '@/shared/validation/input';
import { assertMatchesSchema } from '@/shared/validation/typebox-guard';
import { createIncidentRequestDtoSchema } from './create-incident.schema';

export type CreateIncidentCommandResult = Promise<string>;

export type CreateIncidentCommandPayload = Omit<
  CreateIncidentProps,
  'startedAt'
> & {
  orgId: string;
  userId: string | null;
  /** The request's ISO date-time, converted after the check. */
  startedAt?: string | null;
  /** The opening timeline entry. A default is written when absent. */
  message?: string | null;
};

export const createIncidentCommand =
  incidentActionCreator<CreateIncidentCommandPayload>('create');

export default function makeCreateIncident({
  incidentRepository,
  incidentDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof createIncidentCommand>): CreateIncidentCommandResult {
      const { orgId, userId, message, startedAt, ...props } = payload;
      assertMatchesSchema(createIncidentRequestDtoSchema, {
        ...props,
        message,
        startedAt,
      });
      assertNoDuplicates(
        (props.affectedServices ?? []).map((affected) => affected.serviceId),
        'affectedServices',
      );
      // The format check admits a leap second that `Date` cannot read.
      const incident = incidentDomain.declareIncident(orgId, userId, {
        ...props,
        startedAt:
          startedAt === undefined || startedAt === null
            ? undefined
            : parseDate(startedAt, 'startedAt'),
      });

      // Declaring is the first transition, [none] -> investigating, and
      // DOMAIN.md requires every transition to append a timeline entry in the
      // same transaction. incident.created announces it; incident.update_posted
      // is reserved for updates posted on their own.
      await withTenantTransaction(orgId, async (tx) => {
        await incidentRepository.insert(tx, incident);
        await incidentRepository.appendUpdate(tx, {
          orgId,
          incidentId: incident.id,
          status: incident.status,
          message: timelineEntryMessage(message, null, incident.status),
          createdByUserId: userId,
        });
      });

      eventBus.emit(
        incidentCreatedEvent({ id: incident.id, orgId: incident.orgId }),
      );

      return incident.id;
    },
    init() {
      commandBus.register(createIncidentCommand.type, this.handler);
    },
  };
}
