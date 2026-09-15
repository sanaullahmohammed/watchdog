import { serviceActionCreator } from '@/modules/service';
import type { CreateServiceGroupProps } from '@/modules/service/domain/service-group.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceGroupCreatedEvent } from '@/shared/events/service.events';
import { assertNoNullFields } from '@/shared/validation/input';

export type CreateServiceGroupCommandResult = Promise<string>;

export type CreateServiceGroupCommandPayload = CreateServiceGroupProps & {
  orgId: string;
};

export const createServiceGroupCommand =
  serviceActionCreator<CreateServiceGroupCommandPayload>('group.create');

export default function makeCreateServiceGroup({
  serviceGroupRepository,
  serviceGroupDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof createServiceGroupCommand
    >): CreateServiceGroupCommandResult {
      const { orgId, ...props } = payload;
      // GraphQL cannot express "optional but never null", a format, or a
      // minimum length, so these run here, where both surfaces arrive.
      assertNoNullFields(payload);
      const group = serviceGroupDomain.createServiceGroup(orgId, props);

      await withTenantTransaction(orgId, (tx) =>
        serviceGroupRepository.insert(tx, group),
      );

      eventBus.emit(
        serviceGroupCreatedEvent({
          id: group.id,
          orgId: group.orgId,
          slug: group.slug,
        }),
      );

      return group.id;
    },
    init() {
      commandBus.register(createServiceGroupCommand.type, this.handler);
    },
  };
}
