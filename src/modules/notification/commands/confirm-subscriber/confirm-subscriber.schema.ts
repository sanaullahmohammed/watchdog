import { type Static, Type } from 'typebox';

/** The link's query string: a 32-byte token in base64url. */
export const confirmSubscriberRequestDtoSchema = Type.Object({
  token: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
});

export type ConfirmSubscriberRequestDto = Static<
  typeof confirmSubscriberRequestDtoSchema
>;
