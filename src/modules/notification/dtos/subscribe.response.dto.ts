import { Type } from 'typebox';

/** The one answer every accepted subscribe request gets, whatever the address's state. */
export const SUBSCRIBE_ACCEPTED_MESSAGE =
  'If this address is not already subscribed, a confirmation email is on its way.';

export const subscribeAcceptedDtoSchema = Type.Object({
  message: Type.String(),
});
