import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { Pool } from 'pg';
import env from '../../../config/env';

/**
 * Better Auth owns identity, organizations, teams, memberships and invitations.
 * It sits outside the CQRS bus and outside WatchDog's tenant RLS policies;
 * see ARCHITECTURE.md sections 6.4 and 7.
 *
 * The config import is relative rather than the usual `@/config`, because the
 * Better Auth CLI loads this file standalone to generate the schema and cannot
 * resolve the `@/*` tsconfig path alias. Going through `@/config` matters:
 * env-schema validates `.env` and returns an object without ever writing to
 * `process.env`, so a module reading `process.env` directly sees nothing from
 * `.env` and only works when variables are exported by hand.
 *
 * Better Auth speaks to Postgres through Kysely over `pg`. WatchDog's own data
 * access stays on raw `postgres.js`; the two never share a connection.
 */
export const auth = betterAuth({
  database: new Pool({ connectionString: env.db.url }),
  secret: env.auth.secret,
  baseURL: env.auth.baseUrl,
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
