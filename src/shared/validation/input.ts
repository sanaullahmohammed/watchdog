import { ArgumentInvalidException } from '@/shared/exceptions';

/**
 * Guards for input that reached a command without passing a TypeBox schema.
 *
 * REST bodies are validated by TypeBox before a handler sees them. GraphQL has
 * no equivalent: SDL cannot express a format, a minimum length, or "optional
 * but never null", so a resolver hands the command whatever the client sent.
 * Every case here was a 500 for an ordinary client mistake (Epic 2
 * retrospective, R-9), which is a lie: the request was understood and refused.
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
 * The same, for a field that may be omitted. Absent and null both mean "not
 * supplied"; an empty string is a mistake rather than an absence, so it is
 * refused rather than quietly ignored.
 */
export function parseOptionalDate(
  value: string | null | undefined,
  field: string,
): Date | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseDate(value, field);
}

/**
 * Refuses an explicit null for a field that cannot hold one.
 *
 * Handlers and repositories read a patch as "a key that is present is written",
 * so a null reaches a NOT NULL column as a constraint violation, and a null
 * where a list is expected crashes on `.length`. Omitting a field is how a
 * caller leaves it alone; `nullable` names the fields where null is a value
 * the caller may genuinely mean, such as clearing a description.
 */
export function assertNoNullFields(
  // `object`, not Record<string, unknown>: a command payload is an interface,
  // and an interface has no implicit index signature to match that with.
  input: object,
  options: { nullable?: readonly string[] } = {},
): void {
  const nullable = new Set(options.nullable ?? []);
  const offenders = Object.entries(input)
    .filter(([key, value]) => value === null && !nullable.has(key))
    .map(([key]) => key);

  if (offenders.length > 0) {
    throw new ArgumentInvalidException(
      `${offenders.join(', ')} cannot be null. Omit a field to leave it unchanged.`,
    );
  }
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

/** Refuses text that is empty once trimmed: it says nothing while looking like it does. */
export function assertNotBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ArgumentInvalidException(`${field} must not be blank.`);
  }
}
