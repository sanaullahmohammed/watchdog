import { userCreatedEvent } from '@/shared/events/user.events';

export default function makeCreateSettings({ eventBus, logger }: Dependencies) {
  return {
    handler(action: ReturnType<typeof userCreatedEvent>) {
      logger.info(action);
      // todo: add some logic here to create default settings for the user
    },
    init() {
      eventBus.on(userCreatedEvent.type, this.handler);
    },
  };
}
