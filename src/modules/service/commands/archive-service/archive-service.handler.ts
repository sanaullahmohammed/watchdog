import { serviceActionCreator } from '@/modules/service';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceArchivedEvent } from '@/shared/events/service.events';
import { NotFoundException } from '@/shared/exceptions';

export type ArchiveServiceCommandResult = Promise<boolean>;

export const archiveServiceCommand = serviceActionCreator<{
  orgId: string;
  id: string;
}>('archive');

export default function makeArchiveService({
  serviceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof archiveServiceCommand>): ArchiveServiceCommandResult {
      const { orgId, id } = payload;

      const changed = await withTenantTransaction(orgId, async (tx) => {
        const moved = await serviceRepository.archive(tx, id);
        if (moved) {
          return moved;
        }
        // Nothing moved. Either the service was already in this state, which is
        // a no-op, or it is out of scope, which is a 404. Only a read inside the
        // same tenant transaction can tell them apart.
        const existing = await serviceRepository.findById(tx, id);
        if (!existing) {
          throw new NotFoundException(`Service ${id} not found`);
        }
        return undefined;
      });

      if (!changed) {
        return false;
      }

      eventBus.emit(
        serviceArchivedEvent({
          id: changed.id,
          orgId: changed.orgId,
          slug: changed.slug,
        }),
      );

      return true;
    },
    init() {
      commandBus.register(archiveServiceCommand.type, this.handler);
    },
  };
}
