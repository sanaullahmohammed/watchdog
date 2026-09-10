import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { Pool } from 'pg';
import authEnv from '../../config/auth-env';

/**
 * Better Auth owns identity, organizations, teams, memberships and invitations.
 * It sits outside the CQRS bus and outside WatchDog's tenant RLS policies;
 * see ARCHITECTURE.md sections 6.4 and 7.
 *
 * Deliberately outside `src/server/plugins/`: @fastify/autoload scans that
 * directory recursively and evaluates whatever it finds, and this module is a
 * configured Better Auth instance rather than a Fastify plugin. The plugin that
 * mounts it lives at `src/server/plugins/auth.ts`.
 *
 * Config comes from `config/auth-env`, imported by relative path on purpose.
 * The Better Auth CLI loads this file standalone and cannot resolve the `@/*`
 * tsconfig path alias. It also deliberately reads the narrow auth schema rather
 * than the full application config: the CLI has no use for LOG_LEVEL or
 * NODE_ENV and should not fail when they are absent.
 *
 * Reading env through a schema rather than `process.env` is what makes `.env`
 * work at all here: env-schema validates the file into an object and never
 * writes to `process.env`, so a module reading the latter sees nothing.
 *
 * Better Auth speaks to Postgres through Kysely over `pg`. WatchDog's own data
 * access stays on raw `postgres.js`; the two never share a connection.
 */
export const auth = betterAuth({
  database: new Pool({ connectionString: authEnv.databaseUrl }),
  secret: authEnv.secret,
  baseURL: authEnv.baseUrl,
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    // v1 RBAC is the plugin's built-in owner/admin/member ladder.
    // Table names are configurable via `schema.*.modelName`; leaving them at
    // their defaults is what makes the generated DDL the FK contract.
    organization({
      teams: {
        enabled: true,
      },
    }),
  ],
});

export type Auth = typeof auth;
