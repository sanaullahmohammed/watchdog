import { type Static, Type } from 'typebox';

/**
 * The request payload. `orgId` is deliberately absent: the organization comes
 * from the request context, never from the caller. See ARCHITECTURE.md 3.
 *
 * Field names here must match the SDL input in `create-service.graphql-schema.ts`;
 * `api-surface-parity.spec.ts` fails the build if they drift.
 */
export const createServiceRequestDtoSchema = Type.Object({
  name: Type.String({
    example: 'Checkout API',
    description: 'Human-readable service name',
    minLength: 1,
    maxLength: 120,
  }),
  slug: Type.String({
    example: 'checkout-api',
    description:
      'Unique per organization, and reserved permanently once archived',
    minLength: 1,
    maxLength: 120,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  }),
  description: Type.Optional(
    Type.String({ description: 'Optional detail shown on the status page' }),
  ),
  isPublic: Type.Optional(
    Type.Boolean({
      description: 'Whether the service appears on public pages',
    }),
  ),
  displayOrder: Type.Optional(
    Type.Integer({ description: 'Ordering on public pages', minimum: 0 }),
  ),
  serviceGroupId: Type.Optional(
    Type.String({
      format: 'uuid',
      description: 'Group this service belongs to',
    }),
  ),
});

export type CreateServiceRequestDto = Static<
  typeof createServiceRequestDtoSchema
>;
