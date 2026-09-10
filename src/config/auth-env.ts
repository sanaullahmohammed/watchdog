import envSchema from 'env-schema';
import { type Static, Type } from 'typebox';

/**
 * The subset of configuration Better Auth needs, validated on its own.
 *
 * Kept separate from the application schema on purpose. The Better Auth CLI
 * loads `auth.ts` standalone to generate and verify the schema, and it should
 * not have to satisfy the whole application's configuration surface to do it.
 * Folding these keys into the app schema made `auth:schema:check` fail in CI
 * demanding LOG_LEVEL and NODE_ENV, which Better Auth has no use for.
 *
 * `src/config/env.ts` composes these properties into the wider application
 * schema, so each variable is still declared exactly once.
 */
export const authEnvProperties = {
  DATABASE_URL: Type.String(),
  BETTER_AUTH_SECRET: Type.String({ minLength: 32 }),
  BETTER_AUTH_URL: Type.String({ default: 'http://localhost:3000' }),
};

const schema = Type.Object(authEnvProperties);

const authEnv = envSchema<Static<typeof schema>>({
  dotenv: true,
  schema,
});

export default {
  databaseUrl: authEnv.DATABASE_URL,
  secret: authEnv.BETTER_AUTH_SECRET,
  baseUrl: authEnv.BETTER_AUTH_URL,
};
