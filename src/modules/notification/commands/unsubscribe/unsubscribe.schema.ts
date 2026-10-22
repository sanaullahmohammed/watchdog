import { type Static, Type } from 'typebox';

/** The link's query string. The signature is 32 bytes in base64url. */
export const unsubscribeRequestDtoSchema = Type.Object({
  subscriber: Type.String({ format: 'uuid' }),
  signature: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
});

export type UnsubscribeRequestDto = Static<typeof unsubscribeRequestDtoSchema>;
