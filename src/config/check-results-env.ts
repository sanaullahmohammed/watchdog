import { Type } from 'typebox';

/**
 * Raw check results are kept this many days; the worker drops monthly
 * partitions wholly older than that. Declared apart from `env.ts`, which
 * composes it, so a unit spec can read the default without a `.env`.
 */
export const checkResultsEnvProperties = {
  CHECK_RESULTS_RETENTION_DAYS: Type.Integer({
    default: 30,
    minimum: 1,
    maximum: 36_500,
  }),
};
