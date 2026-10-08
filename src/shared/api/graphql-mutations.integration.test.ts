import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  createService,
  createServiceGroup,
  declareIncident,
  scheduleMaintenance,
} from '@/shared/testing/fixtures';
import { type GraphqlResult, gql } from '@/shared/testing/graphql';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 9.11: every GraphQL mutation succeeds, refuses anonymous callers and
 * refuses bad input, over HTTP.
 *
 * Parity between REST and GraphQL is checked by field names, so a mutation
 * could ship without ever having run over GraphQL. The registry below holds
 * one entry per mutation, and the guard fails when it and the merged schema
 * disagree in either direction.
 */

const tag = `mut-${randomBytes(4).toString('hex')}`;
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';

type Variables = Record<string, unknown>;

type Entry = {
  /** The whole operation, with variables declared for every argument. */
  query: string;
  /** Arguments that succeed, built from fresh fixtures. */
  valid: () => Promise<Variables>;
  /** `true` for `Boolean!`; the target's id; or an id that did not exist. */
  returns: 'true' | 'same-id' | 'new-id';
  /** For `new-id`: the table the new row must be found in. */
  table?: string;
  /** Arguments the handler's own schema refuses, and the field it must name. */
  invalid: () => Promise<Variables>;
  field: string;
  /** What must be unchanged after the refusal. Absent for a malformed id. */
  snapshot?: (variables: Variables) => Promise<unknown>;
};

const rest = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  });

async function ok(response: ReturnType<typeof rest>) {
  const result = await response;
  assert.ok(result.statusCode < 300, result.body);
}

const count = (table: string) => async () =>
  withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from ${tx(table)}
    `;
    return row.n;
  });

const rowOf = (table: string) => async (variables: Variables) =>
  withTenantTransaction(orgId, async ({ sql: tx }) => {
    return tx`select * from ${tx(table)} where id = ${variables.id as string}`;
  });

async function incidentState(variables: Variables) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const id = variables.id as string;
    const incident = await tx`select * from incidents where id = ${id}`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from incident_updates where incident_id = ${id}
    `;
    return { incident, updates: n };
  });
}

/** The six id-only mutations have no input rule, so a malformed id is the refusal. */
const BAD_ID = {
  invalid: async () => ({ id: 'not-a-uuid' }),
  field: 'id',
};

const registry: Record<string, Entry> = {
  createService: {
    query: `mutation ($input: CreateServicePayload!) { createService(input: $input) }`,
    valid: async () => ({
      input: { name: `${tag}-a`, slug: `${tag}-a-${Date.now()}` },
    }),
    returns: 'new-id',
    table: 'services',
    invalid: async () => ({
      input: { name: 'Valid name', slug: 'INVALID SLUG!' },
    }),
    field: 'slug',
    snapshot: count('services'),
  },
  updateService: {
    query: `mutation ($id: ID!, $input: UpdateServicePayload!) { updateService(id: $id, input: $input) }`,
    valid: async () => ({
      id: await createService(app, cookie),
      input: { name: 'Renamed' },
    }),
    returns: 'same-id',
    invalid: async () => ({
      id: await createService(app, cookie),
      input: { name: '' },
    }),
    field: 'name',
    snapshot: rowOf('services'),
  },
  archiveService: {
    query: `mutation ($id: ID!) { archiveService(id: $id) }`,
    valid: async () => ({ id: await createService(app, cookie) }),
    returns: 'true',
    ...BAD_ID,
  },
  restoreService: {
    query: `mutation ($id: ID!) { restoreService(id: $id) }`,
    valid: async () => {
      const id = await createService(app, cookie);
      await ok(rest('POST', `/services/${id}/archive`));
      return { id };
    },
    returns: 'true',
    ...BAD_ID,
  },
  setServiceStatusOverride: {
    query: `mutation ($id: ID!, $input: SetStatusOverridePayload!) { setServiceStatusOverride(id: $id, input: $input) }`,
    valid: async () => ({
      id: await createService(app, cookie),
      input: { status: 'degraded' },
    }),
    returns: 'true',
    invalid: async () => ({ id: 'not-a-uuid', input: { status: 'degraded' } }),
    field: 'id',
  },
  clearServiceStatusOverride: {
    query: `mutation ($id: ID!) { clearServiceStatusOverride(id: $id) }`,
    valid: async () => {
      const id = await createService(app, cookie);
      await ok(
        rest('PUT', `/services/${id}/status-override`, {
          status: 'degraded',
        }),
      );
      return { id };
    },
    returns: 'true',
    ...BAD_ID,
  },
  createServiceGroup: {
    query: `mutation ($input: CreateServiceGroupPayload!) { createServiceGroup(input: $input) }`,
    valid: async () => ({
      input: { name: `${tag}-g`, slug: `${tag}-g-${Date.now()}` },
    }),
    returns: 'new-id',
    table: 'service_groups',
    invalid: async () => ({ input: { name: 'Valid name', slug: 'Has Space' } }),
    field: 'slug',
    snapshot: count('service_groups'),
  },
  updateServiceGroup: {
    query: `mutation ($id: ID!, $input: UpdateServiceGroupPayload!) { updateServiceGroup(id: $id, input: $input) }`,
    valid: async () => ({
      id: await createServiceGroup(app, cookie),
      input: { name: 'Renamed' },
    }),
    returns: 'same-id',
    invalid: async () => ({
      id: await createServiceGroup(app, cookie),
      input: { displayOrder: -1 },
    }),
    field: 'displayOrder',
    snapshot: rowOf('service_groups'),
  },
  deleteServiceGroup: {
    query: `mutation ($id: ID!) { deleteServiceGroup(id: $id) }`,
    valid: async () => ({ id: await createServiceGroup(app, cookie) }),
    returns: 'true',
    ...BAD_ID,
  },
  createIncident: {
    query: `mutation ($input: CreateIncidentPayload!) { createIncident(input: $input) }`,
    valid: async () => ({ input: { title: `${tag}-i`, impact: 'minor' } }),
    returns: 'new-id',
    table: 'incidents',
    invalid: async () => ({
      input: { title: 'x'.repeat(201), impact: 'minor' },
    }),
    field: 'title',
    snapshot: count('incidents'),
  },
  updateIncident: {
    query: `mutation ($id: ID!, $input: UpdateIncidentPayload!) { updateIncident(id: $id, input: $input) }`,
    valid: async () => ({
      id: await declareIncident(app, cookie),
      input: { title: `${tag}-renamed` },
    }),
    returns: 'same-id',
    invalid: async () => ({
      id: await declareIncident(app, cookie),
      input: { title: '' },
    }),
    field: 'title',
    snapshot: rowOf('incidents'),
  },
  transitionIncident: {
    query: `mutation ($id: ID!, $input: TransitionIncidentPayload!) { transitionIncident(id: $id, input: $input) }`,
    valid: async () => ({
      id: await declareIncident(app, cookie),
      input: { status: 'identified' },
    }),
    returns: 'same-id',
    invalid: async () => ({
      id: await declareIncident(app, cookie),
      input: { status: 'identified', message: '' },
    }),
    field: 'message',
    snapshot: incidentState,
  },
  postIncidentUpdate: {
    query: `mutation ($id: ID!, $input: PostIncidentUpdatePayload!) { postIncidentUpdate(id: $id, input: $input) }`,
    valid: async () => ({
      id: await declareIncident(app, cookie),
      input: { message: 'We are looking into it.' },
    }),
    returns: 'new-id',
    table: 'incident_updates',
    invalid: async () => ({
      id: await declareIncident(app, cookie),
      input: { message: '   ' },
    }),
    field: 'message',
    snapshot: incidentState,
  },
  scheduleMaintenance: {
    query: `mutation ($input: ScheduleMaintenancePayload!) { scheduleMaintenance(input: $input) }`,
    valid: async () => ({
      input: {
        title: `${tag}-w`,
        scheduledStartAt: new Date(Date.now() + HOUR).toISOString(),
        scheduledEndAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      },
    }),
    returns: 'new-id',
    table: 'maintenance',
    invalid: async () => ({
      input: {
        title: `${tag}-w`,
        scheduledStartAt: 'the day after tomorrow',
        scheduledEndAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      },
    }),
    field: 'scheduledStartAt',
    snapshot: count('maintenance'),
  },
  updateMaintenance: {
    query: `mutation ($id: ID!, $input: UpdateMaintenancePayload!) { updateMaintenance(id: $id, input: $input) }`,
    valid: async () => ({
      id: await scheduleMaintenance(app, cookie),
      input: { title: `${tag}-renamed` },
    }),
    returns: 'same-id',
    invalid: async () => ({
      id: await scheduleMaintenance(app, cookie),
      input: { affectedServiceIds: null },
    }),
    field: 'affectedServiceIds',
    snapshot: rowOf('maintenance'),
  },
  deleteMaintenance: {
    query: `mutation ($id: ID!) { deleteMaintenance(id: $id) }`,
    valid: async () => ({ id: await scheduleMaintenance(app, cookie) }),
    returns: 'true',
    ...BAD_ID,
  },
  completeMaintenance: {
    query: `mutation ($id: ID!) { completeMaintenance(id: $id) }`,
    valid: async () => ({ id: await scheduleMaintenance(app, cookie) }),
    returns: 'true',
    ...BAD_ID,
  },
};

describe('Every GraphQL mutation runs over GraphQL (story 9.11)', () => {
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

  it('has one registry entry for each Mutation field, and no others', () => {
    const mutation = app.graphql.schema.getMutationType();
    assert.ok(mutation, 'the merged schema has no Mutation type');
    const fields = Object.keys(mutation.getFields());
    const entries = Object.keys(registry);
    const missing = fields.filter((f) => !entries.includes(f));
    const stale = entries.filter((e) => !fields.includes(e));
    assert.deepEqual(
      { missing, stale },
      { missing: [], stale: [] },
      `mutations with no registry entry: [${missing.join(', ')}]; entries for mutations that do not exist: [${stale.join(', ')}]`,
    );
  });

  for (const [field, entry] of Object.entries(registry)) {
    describe(field, () => {
      it('succeeds over GraphQL', async () => {
        const variables = await entry.valid();
        await app.eventBus.drain();
        const result = await gql(app, entry.query, { variables, cookie });
        await app.eventBus.drain();

        assert.equal(result.statusCode, 200, JSON.stringify(result.body));
        assert.equal(
          result.body.errors,
          undefined,
          JSON.stringify(result.body),
        );
        assert.deepEqual(Object.keys(result.body.data ?? {}), [field]);
        const value = result.body.data?.[field];
        if (entry.returns === 'true') assert.equal(value, true);
        else if (entry.returns === 'same-id') assert.equal(value, variables.id);
        else {
          assert.match(String(value), UUID);
          assert.notEqual(value, variables.id);
          const table = entry.table as string;
          const rows = await withTenantTransaction(orgId, ({ sql: tx }) => {
            return tx`select id from ${tx(table)} where id = ${String(value)}`;
          });
          assert.equal(rows.length, 1, `no single row in ${table}`);
        }
      });

      it('refuses a request with no session', async () => {
        const variables = await entry.valid();
        await app.eventBus.drain();
        const before = await entry.snapshot?.(variables);
        const result = await gql(app, entry.query, { variables });
        await app.eventBus.drain();

        assert.equal(result.statusCode, 200, JSON.stringify(result.body));
        assert.equal(result.body.data, null);
        assert.equal(
          result.body.errors?.[0]?.extensions?.code,
          'UNAUTHENTICATED',
          JSON.stringify(result.body),
        );
        if (entry.snapshot) {
          assert.deepEqual(await entry.snapshot(variables), before);
        }
      });

      it('refuses invalid input and writes nothing', async () => {
        const variables = await entry.invalid();
        await app.eventBus.drain();
        const before = await entry.snapshot?.(variables);
        const result: GraphqlResult = await gql(app, entry.query, {
          variables,
          cookie,
        });
        await app.eventBus.drain();

        assert.equal(result.statusCode, 400, JSON.stringify(result.body));
        assert.equal(result.body.data, null);
        const message = result.body.errors?.[0]?.message ?? '';
        assert.match(
          message,
          new RegExp(`^Invalid input\\. (?:.*; )?${entry.field}: `),
        );
        if (entry.snapshot) {
          assert.deepEqual(await entry.snapshot(variables), before);
        }
      });
    });
  }
});
