import { incidentActionCreator } from '@/modules/incident';
import type { UpdateIncidentProps } from '@/modules/incident/domain/incident.domain';
import type { IncidentImpact } from '@/modules/incident/domain/incident.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentUpdatedEvent } from '@/shared/events/incident.events';
import { NotFoundException } from '@/shared/exceptions';
import { anyChanged, sameSet } from '@/shared/utils/changes';
import {
  assertNoDuplicates,
  assertNoNullFields,
} from '@/shared/validation/input';

export type UpdateIncidentCommandResult = Promise<string>;

export type UpdateIncidentCommandPayload = UpdateIncidentProps & {
  orgId: string;
  id: string;
  affectedServices?: { serviceId: string; impact: IncidentImpact }[];
};

export const updateIncidentCommand =
  incidentActionCreator<UpdateIncidentCommandPayload>('update');

export default function makeUpdateIncident({
  incidentRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof updateIncidentCommand>): UpdateIncidentCommandResult {
      const { orgId, id, affectedServices, ...patch } = payload;
      // GraphQL cannot express "optional but never null", a format, or a
      // minimum length, so these run here, where both surfaces arrive.
      assertNoNullFields(payload);
      assertNoDuplicates(
        (affectedServices ?? []).map((affected) => affected.serviceId),
        'affectedServices',
      );

      const { updated, changed } = await withTenantTransaction(
        orgId,
        async (tx) => {
          // The row as it was, to compare against the row as it is. A patch
          // that omits a field says nothing about it, so comparing the request
          // with the row would read an omission as a change.
          const before = await incidentRepository.findById(tx, id);
          if (!before) {
            throw new NotFoundException(`Incident ${id} not found`);
          }

          const incident = await incidentRepository.updateDetails(
            tx,
            id,
            patch,
          );
          if (!incident) {
            throw new NotFoundException(`Incident ${id} not found`);
          }

          if (affectedServices !== undefined) {
            await incidentRepository.replaceAffectedServices(
              tx,
              incident,
              affectedServices,
            );
          }

          const cover = (
            affected: readonly { serviceId: string; impact: string }[],
          ) =>
            affected.map(({ serviceId, impact }) => `${serviceId}:${impact}`);

          return {
            updated: incident,
            changed:
              anyChanged(before, incident, ['title', 'impact', 'startedAt']) ||
              (affectedServices !== undefined &&
                !sameSet(
                  cover(before.affectedServices),
                  cover(affectedServices),
                )),
          };
        },
      );

      // Distinct from incident.state_changed on purpose. Retitling an incident
      // and advancing its lifecycle are different things to anyone listening,
      // and only one of them is a change customers are told about.
      //
      // An edit that changed nothing announces nothing: it would otherwise
      // trigger a recomputation and, from Epic 4, wake every subscriber
      // (Epic 2 retrospective, D-3). Two concurrent edits are not serialized
      // here, so both may announce; neither can stay silent about a change it
      // made.
      if (changed) {
        eventBus.emit(
          incidentUpdatedEvent({ id: updated.id, orgId: updated.orgId }),
        );
      }

      return updated.id;
    },
    init() {
      commandBus.register(updateIncidentCommand.type, this.handler);
    },
  };
}
