import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { type TSchema, Type } from 'typebox';
import { ArgumentInvalidException } from '@/shared/exceptions';

/**
 * Applies a slice's TypeBox request schema inside a command handler.
 *
 * REST validates the body before a handler sees it; GraphQL's SDL cannot
 * express a length, a pattern, a minimum, or "optional but never null", so a
 * handler that skips this stores what REST refuses. The rules stay written once,
 * in the slice's `*.schema.ts`, and the handler checks them here so both
 * surfaces refuse the same values. Check before any SQL and before any emit, so
 * a refusal writes and announces nothing.
 *
 * The engine is ajv, the one Fastify validates REST with, never
 * `typebox/value`: TypeBox counts `maxLength` in graphemes and ajv in code
 * points, so one engine on each surface would judge the same schema differently.
 * The options and formats match Fastify's (`build-app.ts`) except `allErrors`,
 * so a refusal names every field, and no `coerceTypes`, `removeAdditional` or `useDefaults`:
 * a handler checks the value as it arrived.
 */
const ajv = addFormats(new Ajv({ keywords: ['example'], allErrors: true }));

/** The most fields one refusal names; the rest are counted. */
const MAX_NAMED_FIELDS = 10;

const validators = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: TSchema): ValidateFunction {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  return validate;
}

/** Throws `ArgumentInvalidException` (400) unless `value` satisfies `schema`. */
export function assertMatchesSchema(schema: TSchema, value: unknown): void {
  const validate = validatorFor(schema);
  if (validate(value)) {
    return;
  }

  // One entry per field: a union reports a failure for each branch.
  const problems = new Map<string, string>();
  for (const error of validate.errors ?? []) {
    const path = error.instancePath.replace(/^\//, '');
    const field =
      error.keyword === 'required'
        ? [path, String(error.params.missingProperty)].filter(Boolean).join('/')
        : path;
    if (!problems.has(field)) {
      problems.set(field, error.message ?? 'is invalid');
    }
  }
  // A long list of bad items would otherwise echo one entry per item.
  const shown = [...problems]
    .slice(0, MAX_NAMED_FIELDS)
    .map(([field, message]) => (field ? `${field}: ${message}` : message));
  const more = problems.size - shown.length;
  const text =
    more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ');
  throw new ArgumentInvalidException(`Invalid input. ${text}`);
}

const uuidSchemas = new Map<string, TSchema>();

/**
 * Refuses an id that is not a UUID, before it can reach Postgres as a masked
 * 500. It goes through `assertMatchesSchema`, with a schema built once per
 * field name, so the message names the field.
 */
export function assertUuid(value: unknown, field: string): void {
  let schema = uuidSchemas.get(field);
  if (!schema) {
    schema = Type.Object({ [field]: Type.String({ format: 'uuid' }) });
    uuidSchemas.set(field, schema);
  }
  assertMatchesSchema(schema, { [field]: value });
}
