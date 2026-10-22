import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import {
  FEED_BATCH,
  FEED_ENTRIES,
  FEED_MAX_BATCHES,
} from '@/modules/notification/queries/get-atom-feed/get-atom-feed.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  archiveService,
  createService,
  declareIncident,
  insertDraftIncident,
  insertIncidentUpdate,
  scheduleMaintenance,
  transitionDueMaintenance,
} from '@/shared/testing/fixtures';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 6.8: follow a status page as an Atom feed.
 *
 * Each test has an organization of its own. Seeded incident entries are spaced
 * with `createdAtOffset`, and window order is asserted against the timestamps
 * read back from the rows, never the order they were seeded in: the clock
 * steps back on some machines.
 *
 * Sabotage this suite must catch (spec 6.8, AC 3):
 * - one batch only: "reaches past a batch of hidden changes";
 * - no cap: "stops at the scan cap and still answers a valid feed";
 * - no `escapeXml`: "escapes markup and drops a forbidden character";
 * - no `publicTimelineEntry` filter: "leaves out what the page leaves out"
 *   (the draft-era entries);
 * - no `isolation: 'repeatable read'` in the handler: "reads every batch
 *   from one snapshot";
 * - no `publishable`: "leaves out what the page leaves out" (hidden and
 *   archived services, in the same test).
 */

const HOUR = 60 * 60 * 1000;
const tag = `feed-${randomBytes(4).toString('hex')}`;
const ORIGIN = 'https://elsewhere.example';

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];
let counter = 0;

type Org = { cookie: string; orgId: string; slug: string };

async function newOrg(): Promise<Org> {
  counter += 1;
  const slug = `${tag}-${counter}`;
  const { cookie, orgId, userId } = await signUpWithOrg(app, slug);
  created.push({ orgId, userId });
  return { cookie, orgId, slug };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  htmlEntities: true,
  isArray: (name) => name === 'entry' || name === 'link',
});

type ParsedEntry = {
  id: string;
  title: string;
  updated: string;
  link: { '@_rel': string; '@_href': string }[];
  content: { '#text': string; '@_type': string };
};
type ParsedFeed = {
  '@_xmlns': string;
  id: string;
  title: string;
  updated: string;
  author: { name: string };
  link: { '@_rel': string; '@_href': string }[];
  entry?: ParsedEntry[];
};

const feedOf = (body: string): ParsedFeed => parser.parse(body).feed;

const get = (
  slug: string,
  headers: Record<string, string> = {},
  method: 'GET' | 'HEAD' = 'GET',
) => app.inject({ method, url: `/status/${slug}/feed.atom`, headers });

async function read(org: Org) {
  const response = await get(org.slug);
  assert.equal(response.statusCode, 200, response.body);
  const feed = feedOf(response.body);
  return { response, feed, entries: feed.entry ?? [] };
}

/** The last path segments of an entry id: `incident-update/<id>` and so on. */
const idTail = (entry: ParsedEntry) =>
  entry.id.slice(entry.id.indexOf('/') + 1);

const assertPublicHeaders = (headers: Record<string, unknown>) => {
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-expose-headers'], 'ETag, Retry-After');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(headers['access-control-allow-credentials'], undefined);
};

type Stamp = { tail: string; at: bigint; id: string; rank: number };

/** Every change of an organization as the rows say it happened, newest first. */
async function expectedOrder(
  orgId: string,
  excludeIncidentIds: readonly string[] = [],
): Promise<string[]> {
  const stamps = await withTenantTransaction(orgId, async ({ sql: tx }) => {
    const out: Stamp[] = [];
    // Microseconds since the epoch, as SQL orders them.
    const updates = await tx<{ id: string; us: string }[]>`
      select iu.id, (extract(epoch from iu.created_at) * 1000000)::bigint::text as us
      from incident_updates iu
      where iu.status <> 'draft'
        and iu.incident_id <> all (${excludeIncidentIds}::text[]::uuid[])
    `;
    for (const u of updates) {
      out.push({
        tail: `incident-update/${u.id}`,
        at: BigInt(u.us),
        id: u.id,
        rank: 0,
      });
    }
    const windows = await tx<
      {
        id: string;
        created_at: string;
        started_at: string | null;
        completed_at: string | null;
      }[]
    >`
      select id,
        (extract(epoch from created_at) * 1000000)::bigint::text as created_at,
        (extract(epoch from started_at) * 1000000)::bigint::text as started_at,
        (extract(epoch from completed_at) * 1000000)::bigint::text as completed_at
      from maintenance
    `;
    for (const w of windows) {
      const phases = [
        ['scheduled', 1, w.created_at],
        ['started', 2, w.started_at],
        ['completed', 3, w.completed_at],
      ] as const;
      for (const [phase, rank, at] of phases) {
        if (at) {
          out.push({
            tail: `maintenance/${w.id}/${phase}`,
            at: BigInt(at),
            id: w.id,
            rank,
          });
        }
      }
    }
    return out;
  });
  return stamps
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;
      if (a.id !== b.id) return a.id < b.id ? 1 : -1;
      return b.rank - a.rank;
    })
    .map((s) => s.tail);
}

/** Many entries on one incident in one statement, at `start` minus n minutes. */
async function bulkUpdates(
  org: Org,
  incidentId: string,
  count: number,
  start: string,
  stepMinutes = 1,
) {
  await withTenantTransaction(org.orgId, async ({ sql: tx }) => {
    await tx`
      insert into incident_updates (
        org_id, incident_id, status, message, created_at
      )
      select ${org.orgId}, ${incidentId}, 'investigating', 'note ' || n,
             now() + ${start}::interval - (n * ${stepMinutes}) * interval '1 minute'
      from generate_series(1, ${count}) as n
    `;
  });
}

describe('story 6.8: the Atom feed', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  after(async () => {
    for (const { orgId, userId } of created) {
      await sql`delete from "organization" where "id" = ${orgId}`;
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('serves a valid Atom document with every required element', async () => {
    const org = await newOrg();
    await declareIncident(app, org.cookie, { title: 'Database outage' });
    const { response, feed, entries } = await read(org);

    assert.equal(
      response.headers['content-type'],
      'application/atom+xml; charset=utf-8',
    );
    assert.ok(
      response.body.startsWith('<?xml version="1.0" encoding="utf-8"?>'),
    );
    assert.equal(feed['@_xmlns'], 'http://www.w3.org/2005/Atom');
    assert.match(feed.id, /^tag:[^,]+,\d{4}-\d{2}-\d{2}:/);
    assert.ok(feed.id.endsWith(`:${org.orgId}`));
    assert.match(feed.title, / status$/);
    assert.ok(feed.author.name);
    assert.deepEqual(
      feed.link.map((l) => [l['@_rel'], l['@_href']]),
      [
        ['alternate', `${env.publicBaseUrl}/status/${org.slug}`],
        ['self', `${env.publicBaseUrl}/status/${org.slug}/feed.atom`],
      ],
    );
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.title, 'Database outage: Investigating');
    assert.equal(entry.content['@_type'], 'text');
    assert.match(entry.content['#text'], /^Status: Investigating/);
    assert.doesNotMatch(entry.content['#text'], /unsubscribe/i);
    assert.equal(entry.link[0]['@_rel'], 'alternate');
    assert.match(entry.updated, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(feed.updated, entry.updated);
    assert.ok(entry.id.startsWith(`${feed.id}/incident-update/`));
  });

  it('lists an incident and a window lifecycle newest first', async () => {
    const org = await newOrg();
    const incidentId = await declareIncident(app, org.cookie);
    await insertIncidentUpdate(org.orgId, {
      incidentId,
      status: 'identified',
      message: 'Found it',
      createdAtOffset: '-3 hours',
    });
    await insertIncidentUpdate(org.orgId, {
      incidentId,
      status: 'monitoring',
      message: 'Fixed',
      createdAtOffset: '-2 hours',
    });
    const windowId = await scheduleMaintenance(app, org.cookie, {
      scheduledStartAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledEndAt: new Date(Date.now() + HOUR).toISOString(),
    });
    await transitionDueMaintenance(app, org.orgId);
    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/maintenance/${windowId}/complete`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    });
    assert.ok(complete.statusCode < 300, complete.body);

    const { entries, feed } = await read(org);
    const expected = await expectedOrder(org.orgId);
    assert.equal(expected.length, 6);
    assert.deepEqual(entries.map(idTail), expected);
    assert.equal(feed.updated, entries[0].updated);
    const phases = entries
      .filter((e) => e.id.includes('/maintenance/'))
      .map((e) => e.id.split('/').pop())
      .sort();
    assert.deepEqual(phases, ['completed', 'scheduled', 'started']);
    const times = entries.map((e) => Date.parse(e.updated));
    assert.deepEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
  });

  it('words a window that ended without starting', async () => {
    const org = await newOrg();
    await scheduleMaintenance(app, org.cookie, {
      title: 'Upgrade',
      scheduledStartAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      scheduledEndAt: new Date(Date.now() - HOUR).toISOString(),
    });
    await transitionDueMaintenance(app, org.orgId);

    const { entries } = await read(org);
    assert.equal(entries.length, 2);
    const completed = entries.find((e) => e.id.endsWith('/completed'));
    assert.equal(
      completed?.title,
      'Maintenance ended without starting: Upgrade',
    );
    assert.equal(
      entries.find((e) => e.id.endsWith('/scheduled'))?.title,
      'Maintenance scheduled: Upgrade',
    );
  });

  it('holds the newest 50 of 55 public changes', async () => {
    const org = await newOrg();
    const incidentId = await declareIncident(app, org.cookie);
    await bulkUpdates(org, incidentId, 54, '-1 hour');

    const { entries } = await read(org);
    const expected = await expectedOrder(org.orgId);
    assert.equal(expected.length, 55);
    assert.equal(entries.length, 50);
    assert.deepEqual(entries.map(idTail), expected.slice(0, 50));
  });

  it('reaches past a batch of hidden changes', async () => {
    const org = await newOrg();
    const hidden = await createService(app, org.cookie, { isPublic: false });
    const onHidden = await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: hidden, impact: 'minor' }],
    });
    const visible = await declareIncident(app, org.cookie);
    // More hidden than one batch, newer than more visible than the feed holds:
    // the first batch keeps nothing.
    await bulkUpdates(org, onHidden, FEED_BATCH + 10, '1 day');
    await bulkUpdates(org, visible, FEED_ENTRIES + 10, '-1 hour');

    const { entries } = await read(org);
    const ids = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ id: string }[]>`
        select id from incident_updates where incident_id = ${visible}
        order by created_at desc, id desc limit 50
      `,
    );
    assert.deepEqual(
      entries.map(idTail),
      ids.map((row) => `incident-update/${row.id}`),
    );
  });

  it('stops at the scan cap and still answers a valid feed', async () => {
    const org = await newOrg();
    const hidden = await createService(app, org.cookie, { isPublic: false });
    const onHidden = await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: hidden, impact: 'minor' }],
    });
    const visible = await declareIncident(app, org.cookie);
    await bulkUpdates(org, onHidden, FEED_BATCH * FEED_MAX_BATCHES, '1 day');
    await bulkUpdates(org, visible, FEED_ENTRIES + 10, '-1 hour');

    const { feed, entries } = await read(org);
    assert.equal(entries.length, 0);
    assert.equal(feed['@_xmlns'], 'http://www.w3.org/2005/Atom');
  });

  it('leaves out what the page leaves out', async () => {
    const org = await newOrg();
    const hidden = await createService(app, org.cookie, { isPublic: false });
    const archived = await createService(app, org.cookie);
    const shown = await createService(app, org.cookie);
    await archiveService(app, org.cookie, archived);

    // Public: one incident on no service, one window on a shown service.
    const keptIncident = await declareIncident(app, org.cookie);
    const keptWindow = await scheduleMaintenance(app, org.cookie, {
      affectedServiceIds: [shown],
    });
    // Left off: services that are not public.
    await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: hidden, impact: 'minor' }],
    });
    await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: archived, impact: 'minor' }],
    });
    await scheduleMaintenance(app, org.cookie, {
      affectedServiceIds: [hidden],
    });
    // A deleted window.
    const deleted = await scheduleMaintenance(app, org.cookie);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/maintenance/${deleted}`,
      headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    });
    assert.ok(del.statusCode < 300, del.body);
    // A draft-era entry and the dismissal that follows it.
    const draft = await insertDraftIncident(org.orgId, {
      title: 'Draft',
      impact: 'major',
    });
    for (const [status, offset] of [
      ['draft', '-2 hours'],
      ['resolved', '-1 hour'],
    ] as const) {
      await insertIncidentUpdate(org.orgId, {
        incidentId: draft,
        status,
        message: 'internal',
        createdAtOffset: offset,
      });
    }
    const { entries } = await read(org);
    const tails = entries.map(idTail);
    const [declaration] = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ id: string }[]>`
        select id from incident_updates where incident_id = ${keptIncident}
      `,
    );
    assert.deepEqual(
      tails.sort(),
      [
        `incident-update/${declaration.id}`,
        `maintenance/${keptWindow}/scheduled`,
      ].sort(),
    );
  });

  it('escapes markup and drops a forbidden character', async () => {
    const org = await newOrg();
    const incidentId = await declareIncident(app, org.cookie, {
      title: `<b>&"'`,
      message: 'line one\r\nline two',
    });
    await withTenantTransaction(org.orgId, async ({ sql: tx }) => {
      await tx`
        update incidents set title = title || chr(1) where id = ${incidentId}
      `;
    });

    const { response, entries } = await read(org);
    assert.ok(!response.body.includes(String.fromCharCode(1)));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, `<b>&"': Investigating`);
    assert.match(entries[0].content['#text'], /line one\r\nline two/);
  });

  it('is a valid feed with no entries for an organization with no changes', async () => {
    const org = await newOrg();
    const { feed, entries } = await read(org);
    const [row] = await sql<{ createdAt: Date }[]>`
      select "createdAt" from "organization" where "id" = ${org.orgId}
    `;
    assert.equal(entries.length, 0);
    assert.equal(feed.updated, row.createdAt.toISOString());
  });

  it('revalidates with a strong tag, and answers a new one after a change', async () => {
    const org = await newOrg();
    await declareIncident(app, org.cookie);
    const first = await get(org.slug);
    const etag = first.headers.etag as string;
    assert.match(etag, /^"[\w-]+"$/);
    assert.equal(
      first.headers['cache-control'],
      `public, max-age=${env.publicSurface.maxAgeSeconds}`,
    );

    const same = await get(org.slug, { 'if-none-match': etag });
    assert.equal(same.statusCode, 304);
    assert.equal(same.body, '');
    assert.equal(same.headers['content-length'], undefined);
    assertPublicHeaders(same.headers);

    await declareIncident(app, org.cookie);
    const changed = await get(org.slug, { 'if-none-match': etag });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, etag);
  });

  it('answers HEAD with the length of the GET and no body', async () => {
    const org = await newOrg();
    await declareIncident(app, org.cookie);
    const getResponse = await get(org.slug);
    const head = await get(org.slug, {}, 'HEAD');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(
      head.headers['content-length'],
      String(Buffer.byteLength(getResponse.body)),
    );
    assert.equal(head.headers.etag, getResponse.headers.etag);
  });

  it('answers HEAD with a matching If-None-Match as a bodiless 304', async () => {
    const org = await newOrg();
    await declareIncident(app, org.cookie);
    const etag = (await get(org.slug)).headers.etag as string;
    const head = await get(
      org.slug,
      { 'if-none-match': etag, origin: ORIGIN },
      'HEAD',
    );
    assert.equal(head.statusCode, 304);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], undefined);
    assertPublicHeaders(head.headers);
  });

  it('reads past a batch that ends on a window row, with no repeat or gap', async () => {
    const org = await newOrg();
    const hidden = await createService(app, org.cookie, { isPublic: false });
    const onHidden = await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: hidden, impact: 'minor' }],
    });
    const visible = await declareIncident(app, org.cookie);
    const windows = [
      await scheduleMaintenance(app, org.cookie),
      await scheduleMaintenance(app, org.cookie),
      await scheduleMaintenance(app, org.cookie),
    ];
    // Scheduled only, started, and completed, all older than both
    // declarations (which are stamped now).
    const stamps = [
      ['-1 hour', null, null],
      ['-6 hours', '-5 hours', null],
      ['-10 hours', '-9 hours', '-8 hours'],
    ] as const;
    await withTenantTransaction(org.orgId, async ({ sql: tx }) => {
      for (const [i, [created, started, completed]] of stamps.entries()) {
        await tx`
          update maintenance set
            created_at = now() + ${created}::interval,
            started_at = now() + ${started}::interval,
            completed_at = now() + ${completed}::interval
          where id = ${windows[i]}
        `;
      }
    });
    // The hidden updates and both declarations fill all of the first batch but
    // one row, so its last row is the newest window row.
    await bulkUpdates(org, onHidden, FEED_BATCH - 3, '1 day');
    await bulkUpdates(org, visible, 20, '-3 days');

    const { entries } = await read(org);
    const tails = entries.map(idTail);
    assert.equal(new Set(tails).size, tails.length, 'no entry repeats');
    const expected = await expectedOrder(org.orgId, [onHidden]);
    assert.equal(expected.length, 1 + 20 + 6);
    assert.deepEqual(tails, expected);
  });

  it('reads every batch from one snapshot', async () => {
    const org = await newOrg();
    const hidden = await createService(app, org.cookie, { isPublic: false });
    const onHidden = await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: hidden, impact: 'minor' }],
    });
    const visible = await declareIncident(app, org.cookie);
    await bulkUpdates(org, onHidden, FEED_BATCH + 10, '1 day');

    const repository = app.diContainer.resolve(
      'publicHistoryRepository' as never,
    ) as {
      latestChanges: (...args: never[]) => Promise<unknown[]>;
    };
    const original = repository.latestChanges;
    let committed = '';
    repository.latestChanges = async (...args) => {
      const batch = await original.apply(repository, args);
      if (!committed) {
        // After the first batch, on another connection: older than that
        // batch's last position, so a later batch would read it if it could.
        const [row] = await withTenantTransaction(
          org.orgId,
          ({ sql: tx }) => tx<{ id: string }[]>`
            insert into incident_updates (
              org_id, incident_id, status, message, created_at
            ) values (
              ${org.orgId}, ${visible}, 'monitoring', 'late',
              now() - interval '1 hour'
            )
            returning id
          `,
        );
        committed = row.id;
      }
      return batch;
    };
    try {
      const { entries } = await read(org);
      const tails = entries.map(idTail);
      assert.ok(committed, 'a second batch was read');
      assert.ok(!tails.includes(`incident-update/${committed}`));
      assert.equal(new Set(tails).size, tails.length, 'no entry repeats');
    } finally {
      repository.latestChanges = original;
    }
    // A later read sees it.
    const after = (await read(org)).entries.map(idTail);
    assert.ok(after.includes(`incident-update/${committed}`));
  });

  it('can be read from another origin, without credentials', async () => {
    const org = await newOrg();
    const read = await get(org.slug, { origin: ORIGIN });
    assert.equal(read.statusCode, 200);
    assertPublicHeaders(read.headers);

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `/status/${org.slug}/feed.atom`,
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'if-none-match',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assertPublicHeaders(preflight.headers);
    assert.match(
      preflight.headers['access-control-allow-headers'] as string,
      /if-none-match/,
    );
  });

  it("gives every miss the page's uniform 404", async () => {
    const org = await newOrg();
    const page = await app.inject({
      method: 'GET',
      url: '/status/no-such-page-here',
    });
    assert.equal(page.statusCode, 404);
    const withoutId = (body: string) =>
      body.replace(/"correlationId":"[^"]*"/, '');
    const misses = [
      await get(`${tag}-unknown`, { origin: ORIGIN }),
      await get('Not_A_Slug', { origin: ORIGIN }),
      await app.inject({
        method: 'POST',
        url: `/status/${org.slug}/feed.atom`,
        headers: { origin: ORIGIN },
      }),
    ];
    for (const miss of misses) {
      assert.equal(miss.statusCode, 404, miss.body);
      assert.equal(withoutId(miss.body), withoutId(page.body));
      assertPublicHeaders(miss.headers);
    }
  });

  it("holds only its own organization's changes", async () => {
    const mine = await newOrg();
    const other = await newOrg();
    await declareIncident(app, other.cookie, { title: 'Theirs' });
    await scheduleMaintenance(app, other.cookie);
    await declareIncident(app, mine.cookie, { title: 'Mine' });

    const { entries } = await read(mine);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Mine: Investigating');
  });

  it('rations anonymous readers by IP, with the public headers', async () => {
    // Its own instance, built while the file's is open: the limiter counts
    // per app, and a spent bucket would refuse every later test.
    const limited = await buildApp({ logger: false });
    await limited.ready();
    const org = await newOrg();
    const max = env.publicSurface.rateLimit.max;
    try {
      let refused: Awaited<ReturnType<typeof limited.inject>> | undefined;
      let sent = 0;
      for (; sent <= max + 2; sent += 1) {
        const response = await limited.inject({
          method: 'GET',
          url: `/status/${org.slug}/feed.atom`,
          headers: { origin: ORIGIN },
        });
        if (response.statusCode === 429) {
          refused = response;
          break;
        }
      }
      assert.ok(refused, `not rationed within ${max + 2}`);
      assert.equal(sent, max, 'refused the request after the limit');
      assertPublicHeaders(refused.headers);
      assert.ok(refused.headers['retry-after']);
    } finally {
      await limited.close();
    }
  });
});
