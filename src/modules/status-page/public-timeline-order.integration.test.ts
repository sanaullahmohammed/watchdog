import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { PublicStatusPageResponseDto } from '@/modules/status-page/dtos/public-status-page.response.dto';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  insertDraftIncident,
  insertIncidentUpdate,
} from '@/shared/testing/fixtures';
import { gqlData } from '@/shared/testing/graphql';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/** Story 5.14 - the public timeline orders by sequence, not the clock. */

const tag = `tlo-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let org: { cookie: string; userId: string; orgId: string };
let incidentId = '';
const slug = tag;

describe('Story 5.14: the public timeline order', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    org = await signUpWithOrg(app, slug);

    incidentId = await insertDraftIncident(org.orgId, {
      title: 'Checkout errors',
      impact: 'major',
    });
    await insertIncidentUpdate(org.orgId, {
      incidentId,
      status: 'draft',
      message: 'Triage note.',
      createdAtOffset: '2 hours',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/transition`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
      payload: { status: 'investigating', message: 'We are investigating.' },
    });
    assert.ok(response.statusCode < 300, response.body);
    await insertIncidentUpdate(org.orgId, {
      incidentId,
      status: 'investigating',
      message: 'first',
      createdAtOffset: '1 hour',
    });
    await insertIncidentUpdate(org.orgId, {
      incidentId,
      status: 'investigating',
      message: 'second',
      createdAtOffset: '-1 hour',
    });
  });

  after(async () => {
    if (org) {
      await sql`delete from "organization" where "id" = ${org.orgId}`;
      await sql`delete from "user" where "id" = ${org.userId}`;
    }
    await app?.close();
    await sql.end({ timeout: 5 });
  });

  const expected = ['We are investigating.', 'first', 'second'];

  it('reads the updates in insert order when the clock stepped back', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const page = JSON.parse(response.body) as PublicStatusPageResponseDto;
    const incident = page.activeIncidents.find((i) => i.id === incidentId);
    assert.ok(incident);
    assert.deepEqual(
      incident.updates.map((u) => u.message),
      expected,
    );
  });

  it('reads the same ids in the same order over GraphQL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const rest = (
      JSON.parse(response.body) as PublicStatusPageResponseDto
    ).activeIncidents.find((i) => i.id === incidentId);
    const data = await gqlData<{
      publicStatusPage: {
        activeIncidents: {
          id: string;
          updates: { id: string; message: string }[];
        }[];
      };
    }>(
      app,
      'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { activeIncidents { id updates { id status message } } } }',
      { variables: { slug } },
    );
    const gql = data.publicStatusPage.activeIncidents.find(
      (i) => i.id === incidentId,
    );
    assert.ok(rest && gql);
    assert.deepEqual(
      gql.updates.map((u) => u.message),
      expected,
    );
    assert.deepEqual(
      gql.updates.map((u) => u.id),
      rest.updates.map((u) => u.id),
    );
  });

  it('matches the admin timeline minus draft entries', async () => {
    const admin = await app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${incidentId}/updates`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    });
    assert.equal(admin.statusCode, 200, admin.body);
    const adminIds = (
      JSON.parse(admin.body) as { id: string; status: string }[]
    )
      .filter((u) => u.status !== 'draft')
      .map((u) => u.id);
    const response = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
    });
    const page = JSON.parse(response.body) as PublicStatusPageResponseDto;
    const incident = page.activeIncidents.find((i) => i.id === incidentId);
    assert.ok(incident);
    assert.deepEqual(
      incident.updates.map((u) => u.id),
      adminIds,
    );
  });

  it('stored the draft-era note and left it out by status', async () => {
    const stored = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ status: string }[]>`
        select status from incident_updates
        where incident_id = ${incidentId}
        order by sequence
      `,
    );
    assert.deepEqual(
      stored.map((r) => r.status),
      ['draft', 'investigating', 'investigating', 'investigating'],
    );
  });

  it('no longer has the created_at timeline index', async () => {
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = current_schema() and tablename = 'incident_updates'
    `;
    const names = rows.map((r) => r.indexname);
    assert.ok(!names.includes('incident_updates_timeline_idx'));
    assert.ok(names.includes('incident_updates_sequence_idx'));
  });
});
