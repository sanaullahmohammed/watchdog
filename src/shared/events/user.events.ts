import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/**
 * Cross-module event contracts.
 *
 * A vertical slice may not import another slice, so any event that crosses a
 * module boundary is declared here and both sides depend on this file instead
 * of on each other. See ARCHITECTURE.md section 1 and the `no-cross-module-deps`
 * rule in .dependency-cruiser.js.
 *
 * The payload is deliberately its own type rather than a re-export of the
 * emitting module's request DTO: a published contract should not change shape
 * because a module reworked its own input validation.
 */
const userEventCreator = actionCreatorFactory('user');

export type UserCreatedEventPayload = {
  id: string;
  email: string;
};

export const userCreatedEvent =
  userEventCreator<UserCreatedEventPayload>('created');
