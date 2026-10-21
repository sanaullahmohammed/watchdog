import { Type } from 'typebox';

/**
 * What a subscriber's address must be after it is trimmed and lowercased: one
 * plain `local@domain` address (ajv's `email` format), at most 254 characters,
 * the longest an address can be. The request schema cannot hold the format,
 * because ajv does not trim.
 */
export const normalizedSubscriberEmailSchema = Type.Object({
  email: Type.String({ format: 'email', maxLength: 254 }),
});

export function normalizeSubscriberEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
