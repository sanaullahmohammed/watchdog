import { type Static, Type } from 'typebox';

/**
 * The request: one path parameter. Its name must match the argument of
 * `monitors` in `list-monitors.graphql-schema.ts`, which the parity contract
 * checks. The response lives in `dtos/`.
 */
export const listMonitorsRequestParamsSchema = Type.Object({
  serviceId: Type.String({ format: 'uuid' }),
});

export type ListMonitorsRequestParams = Static<
  typeof listMonitorsRequestParamsSchema
>;
