import { randomUUID } from 'node:crypto';
import {
  type CreateUserProps,
  type UserEntity,
  UserRoles,
} from '@/modules/user/domain/user.types';

export default function userDomain() {
  return {
    createUser: (create: CreateUserProps): UserEntity => {
      const now = new Date();

      return {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...create,
        role: UserRoles.guest,
      };
    },
  };
}
