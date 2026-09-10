import { serviceActionCreator } from '@/modules/service';
import type { UpdateServiceProps } from '@/modules/service/domain/service.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceUpdatedEvent } from '@/shared/events/service.events';
import { NotFoundException } from '@/shared/exceptions';

export type UpdateServiceCommandResult = Promise<string>;

export type UpdateServiceCommandPayload = UpdateServiceProps & {
  orgId: string;
  id: string;
};

export const updateServiceCommand =
  serviceActionCreator<UpdateServiceCommandPayload>('update');

export default function makeUpdateService({
  serviceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof updateServiceCommand>): UpdateServiceCommandResult {
      const { orgId, id, ...patch } = payload;

      const updated = await withTenantTransaction(orgId, (tx) =>
        serviceRepository.update(tx, id, patch),
      );

      // RLS scoped the write, so a service in another organization simply
      // matched nothing. Reported as not found rather than forbidden: telling
      // a caller the row exists elsewhere would leak across the tenant boundary.
      if (!updated) {
        throw new NotFoundException(`Service ${id} not found`);
      }

      eventBus.emit(
        serviceUpdatedEvent({
          id: updated.id,
          orgId: updated.orgId,
          slug: updated.slug,
        }),
      );

      return updated.id;
    },
    init() {
      commandBus.register(updateServiceCommand.type, this.handler);
    },
  };
}
