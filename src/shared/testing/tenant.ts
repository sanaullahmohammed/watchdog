import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import sql from '@/shared/db/postgres';

/**
 * Scaffolding every integration suite needs: a signed-in operator who owns an
 * organization.
 *
 * It lived as a copy in nineteen files, and the copies had already drifted:
 * three asserted that the sign-up and the organization creation actually
 * succeeded and the rest did not, so a suite whose setup quietly failed
 * reported it as a confusing assertion failure much later. Epic 2
 * retrospective, AV-3.
 */

export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * Better Auth sets several cookies at once. `Headers.forEach` folds repeated
 * headers into one comma-joined value, which corrupts them, so each cookie's
 * name=value pair is taken and rejoined.
 */
export function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

/**
 * The display name an organization gets, deliberately unlike its slug.
 *
 * Both were the label, so a presenter that returned the slug where the page
 * shows the name passed every suite, and the wireframe's heading, "Acme Cloud",
 * is exactly that field (Epic 3 retrospective, VG-H).
 */
export const displayNameFor = (label: string) => `${label} Display Name`;

/** Signs a new operator up and gives them an organization of their own. */
export async function signUpWithOrg(app: FastifyInstance, label: string) {
  const email = `${label}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: TEST_PASSWORD, name: label },
  });
  assert.equal(signUp.statusCode, 200, signUp.body);
  const cookie = captureCookie(signUp.headers as Record<string, unknown>);

  const [{ id: userId }] = await sql<{ id: string }[]>`
    select "id" from "user" where "email" = ${email}
  `;

  const org = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { name: displayNameFor(label), slug: label },
  });
  assert.equal(org.statusCode, 200, org.body);

  return {
    cookie,
    userId,
    orgId: JSON.parse(org.body).id as string,
    name: displayNameFor(label),
  };
}
