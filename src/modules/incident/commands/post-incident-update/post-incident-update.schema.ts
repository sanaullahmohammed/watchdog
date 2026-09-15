import { type Static, Type } from 'typebox';

/**
 * Only the message. The status recorded on a timeline entry is the incident's
 * status at the moment of writing, read inside the same transaction, so a
 * caller cannot post an entry claiming a status the incident never held.
 */
export const postIncidentUpdateRequestDtoSchema = Type.Object({
  message: Type.String({
    minLength: 1,
    maxLength: 4000,
    // minLength alone accepts "   ", which reaches the public timeline saying
    // nothing while looking like it says something.
    pattern: '\\S',
  }),
});

export type PostIncidentUpdateRequestDto = Static<
  typeof postIncidentUpdateRequestDtoSchema
>;
