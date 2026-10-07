import { type Static, Type } from 'typebox';

/**
 * The request: one path parameter. Its name must match the argument of
 * `serviceGroup` in `get-service-group.graphql-schema.ts`, which the parity
 * contract checks. The response lives in `dtos/`.
 */
export const getServiceGroupRequestParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export type GetServiceGroupRequestParams = Static<
  typeof getServiceGroupRequestParamsSchema
>;
