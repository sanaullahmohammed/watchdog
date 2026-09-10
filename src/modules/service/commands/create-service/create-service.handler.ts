import { serviceActionCreator } from '@/modules/service';
import type { CreateServiceProps } from '@/modules/service/domain/service.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceCreatedEvent } from '@/shared/events/service.events';

export type CreateServiceCommandResult = Promise<string>;

/**
 * The organization is carried on the command because the CQRS context
 * middleware described in ARCHITECTURE.md 3 does not exist yet. The route and
 * resolver are the only things that set it, always from the resolved request
 * context and never from the request body.
 */
export type CreateServiceCommandPayload = CreateServiceProps & {
  orgId: string;
};

export const createServiceCommand =
  serviceActionCreator<CreateServiceCommandPayload>('create');

export default function makeCreateService({
  serviceRepository,
  serviceDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof createServiceCommand>): CreateServiceCommandResult {
      const { orgId, ...props } = payload;
      const service = serviceDomain.createService(orgId, props);

      await withTenantTransaction(orgId, async (tx) => {
        await serviceRepository.insert(tx, service);
      });

      eventBus.emit(
        serviceCreatedEvent({
          id: service.id,
          orgId: service.orgId,
          slug: service.slug,
        }),
      );

      return service.id;
    },
    init() {
      commandBus.register(createServiceCommand.type, this.handler);
    },
  };
}
