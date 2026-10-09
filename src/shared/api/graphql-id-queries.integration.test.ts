import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  type GraphQLInputType,
  type GraphQLNamedType,
  getNamedType,
  isInputObjectType,
} from 'graphql';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { gql } from '@/shared/testing/graphql';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Epic 9 retro item 1c: every id-taking GraphQL `Query` field refuses a
 * malformed id with a 400 that names the argument, over HTTP.
 *
 * The registry below holds one entry per such field, and the guard fails when
 * it and the merged schema disagree in either direction (an id-taking field
 * is one with an argument or input field typed `ID`, or named `id` or `...Id`), so a new id-taking
 * read cannot ship without a malformed-id case. It is the `Query` counterpart
 * of the mutation registry in `graphql-mutations.integration.test.ts`.
 */

const tag = `idq-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';

type Entry = {
  /** The whole operation, with `$id` declared as `ID!`. */
  query: string;
  /** The argument the message must name. */
  arg: string;
};

const registry: Record<string, Entry> = {
  incident: {
    query: `query ($id: ID!) { incident(id: $id) { id } }`,
    arg: 'id',
  },
  incidentTimeline: {
    query: `query ($id: ID!) { incidentTimeline(id: $id) { id } }`,
    arg: 'id',
  },
  maintenanceWindow: {
    query: `query ($id: ID!) { maintenanceWindow(id: $id) { id } }`,
    arg: 'id',
  },
  service: {
    query: `query ($id: ID!) { service(id: $id) { id } }`,
    arg: 'id',
  },
  serviceGroup: {
    query: `query ($id: ID!) { serviceGroup(id: $id) { id } }`,
    arg: 'id',
  },
  monitors: {
    query: `query ($id: ID!) { monitors(serviceId: $id) { id } }`,
    arg: 'serviceId',
  },
};

/**
 * `publicStatusPage(orgSlug: ID!)` takes a slug, not an id. It answers every
 * miss the same way by design (AGENTS.md), so a malformed slug is never a 400.
 */
const EXEMPT: Record<string, { reason: string; query: string }> = {
  publicStatusPage: {
    reason:
      'takes an organization slug and answers one uniform miss for any slug',
    query: `query ($id: ID!) { publicStatusPage(orgSlug: $id) { overallStatus } }`,
  },
};

const ID_NAME = /^id$|Id$/;

/**
 * Counts an argument or input field typed `ID`, or named `id` or `...Id`
 * whatever its scalar type, so `serviceId: String!` cannot escape.
 */
function takesId(
  name: string,
  type: GraphQLInputType,
  seen = new Set<string>(),
): boolean {
  const named: GraphQLNamedType = getNamedType(type);
  if (named.name === 'ID' || ID_NAME.test(name)) return true;
  if (!isInputObjectType(named) || seen.has(named.name)) return false;
  seen.add(named.name);
  return Object.values(named.getFields()).some((f) =>
    takesId(f.name, f.type, seen),
  );
}

describe('Every id-taking GraphQL Query field refuses a malformed id', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('has one entry for each id-taking Query field, and no others', () => {
    const query = app.graphql.schema.getQueryType();
    assert.ok(query, 'the merged schema has no Query type');
    const fields = Object.values(query.getFields())
      .filter((f) => f.args.some((a) => takesId(a.name, a.type)))
      .map((f) => f.name);
    const entries = [...Object.keys(registry), ...Object.keys(EXEMPT)];
    const missing = fields.filter((f) => !entries.includes(f));
    const stale = entries.filter((e) => !fields.includes(e));
    assert.deepEqual(
      { missing, stale },
      { missing: [], stale: [] },
      `id-taking queries with no entry: [${missing.join(', ')}]; entries for queries that take no id: [${stale.join(', ')}]`,
    );
  });

  for (const [field, entry] of Object.entries(registry)) {
    it(`${field} answers 400 naming ${entry.arg} for a malformed id`, async () => {
      const result = await gql(app, entry.query, {
        variables: { id: 'not-a-uuid' },
        cookie,
      });

      assert.equal(result.statusCode, 400, JSON.stringify(result.body));
      assert.equal(result.body.data, null);
      assert.match(
        result.body.errors?.[0]?.message ?? '',
        new RegExp(`^Invalid input\\. (?:.*; )?${entry.arg}: `),
      );
    });
  }

  for (const [field, { reason, query }] of Object.entries(EXEMPT)) {
    it(`${field} is exempt: it ${reason}`, async () => {
      const ask = (slug: string) =>
        gql(app, query, { variables: { id: slug } });
      const malformed = await ask('NOT a slug!');
      const unknown = await ask(`${tag}-nobody`);

      assert.notEqual(malformed.statusCode, 400);
      assert.deepEqual(malformed, unknown);
      assert.equal(unknown.body.data, null);
      assert.equal(unknown.body.errors?.[0]?.message, 'Status page not found');
    });
  }
});
