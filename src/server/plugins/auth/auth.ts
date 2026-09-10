import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { Pool } from 'pg';

/**
 * Better Auth owns identity, organizations, teams, memberships and invitations.
 * It sits outside the CQRS bus and outside WatchDog's tenant RLS policies;
 * see ARCHITECTURE.md sections 6.4 and 7.
 *
 * This module reads `process.env` directly rather than going through
 * `@/config`, because the Better Auth CLI loads it standalone to generate the
 * schema and cannot resolve the `@/*` tsconfig path alias.
 *
 * Better Auth speaks to Postgres through Kysely over `pg`. WatchDog's own data
 * access stays on raw `postgres.js`; the two never share a connection.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const auth = betterAuth({
  database: new Pool({ connectionString: required('DATABASE_URL') }),
  secret: required('BETTER_AUTH_SECRET'),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
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
