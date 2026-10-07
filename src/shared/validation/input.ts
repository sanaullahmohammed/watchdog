import { ArgumentInvalidException } from '@/shared/exceptions';

/**
 * Guards that run after a handler has applied its slice's request schema.
 *
 * `parseDate` converts a string the schema's date-time format already
 * accepted, and still refuses one `Date` cannot read, such as a leap second
 * (`...T23:59:60Z`). `assertNoDuplicates` covers a uniqueness rule the request
 * schemas do not express.
 */

/** Parses an ISO date-time, refusing anything `new Date` would call Invalid. */
export function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ArgumentInvalidException(
      `${field} must be an ISO date-time; got ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

/**
 * Refuses a list naming the same thing twice.
 *
 * Both affected-service lists are composite primary keys, so a duplicate is a
 * unique violation the database raises after the write has begun. For incident
 * impacts it is also ambiguous: two rows for one service can disagree.
 */
export function assertNoDuplicates(
  values: readonly string[],
  field: string,
): void {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }

  if (duplicated.size > 0) {
    throw new ArgumentInvalidException(
      `${field} names ${[...duplicated].join(', ')} more than once.`,
    );
  }
}
