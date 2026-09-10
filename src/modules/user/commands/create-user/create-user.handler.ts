import { userActionCreator } from '@/modules/user';
import { UserAlreadyExistsError } from '@/modules/user/domain/user.errors';
import { userCreatedEvent } from '@/shared/events/user.events';
import { ConflictException } from '@/shared/exceptions';
import type { CreateUserRequestDto } from './create-user.schema';

export type CreateUserCommandResult = Promise<string>;
export const createUserCommand =
  userActionCreator<CreateUserRequestDto>('create');

export default function makeCreateUser({
  userRepository,
  userDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof createUserCommand>): CreateUserCommandResult {
      const user = userDomain.createUser(payload);
      try {
        await userRepository.insert(user);
        eventBus.emit(userCreatedEvent({ id: user.id, email: user.email }));
        return user.id;
      } catch (error: any) {
        if (error instanceof ConflictException) {
          throw new UserAlreadyExistsError(error);
        }
        throw error;
      }
    },
    init() {
      commandBus.register(createUserCommand.type, this.handler);
    },
  };
}
