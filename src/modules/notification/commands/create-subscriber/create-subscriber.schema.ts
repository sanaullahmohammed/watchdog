import { type Static, Type } from 'typebox';

/**
 * The raw request. The format lives in `domain/subscriber-email.ts` and is
 * applied after the handler trims and lowercases, because ajv cannot trim and
 * `"  a@b.c "` would fail it here.
 */
export const createSubscriberRequestDtoSchema = Type.Object({
  email: Type.String({ minLength: 1, maxLength: 320 }),
});

export type CreateSubscriberRequestDto = Static<
  typeof createSubscriberRequestDtoSchema
>;
