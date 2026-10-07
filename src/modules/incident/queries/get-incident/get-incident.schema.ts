import { type Static, Type } from 'typebox';

/**
 * The request: one path parameter. Its name must match the argument of
 * `incident` in `get-incident.graphql-schema.ts`, which the parity contract
 * checks. The response lives in `dtos/`.
 */
export const getIncidentRequestParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export type GetIncidentRequestParams = Static<
  typeof getIncidentRequestParamsSchema
>;
