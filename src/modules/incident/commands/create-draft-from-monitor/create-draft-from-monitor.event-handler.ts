import { createDraftFromMonitorCommand } from '@/modules/incident/commands/create-draft-from-monitor/create-draft-from-monitor.handler';
import type { Action } from '@/shared/cqrs/bus.types';
import { monitorThresholdBreachedEvent } from '@/shared/events/monitor.events';

type Breach = ReturnType<typeof monitorThresholdBreachedEvent>['payload'];

/**
 * Proposes a draft when a monitor breaches its threshold (FR13). It subscribes
 * to nothing else: recovery and certificate warnings never touch a draft.
 */
export default function makeCreateDraftFromMonitorEventHandler({
  commandBus,
  eventBus,
  logger,
}: Dependencies) {
  return {
    handler(event: Action<Breach>) {
      const { orgId, monitorId, serviceId, monitorName, failureEpisode } =
        event.payload;
      // Returned so the bus tracks the promise; the catch only adds context.
      return Promise.resolve()
        .then(() =>
          commandBus.execute(
            createDraftFromMonitorCommand({
              orgId,
              monitorId,
              serviceId,
              monitorName,
              failureEpisode,
            }),
          ),
        )
        .catch((error: unknown) => {
          logger.error(
            { err: error, event: event.type, orgId, monitorId, failureEpisode },
            'creating a draft from a monitor breach failed',
          );
        });
    },
    init() {
      eventBus.on(monitorThresholdBreachedEvent.type, this.handler);
    },
  };
}
