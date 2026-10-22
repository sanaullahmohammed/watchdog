import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { env } from '@/config';
import { queueEmailNotificationCommand } from '@/modules/notification/commands/queue-email-notifications/queue-email-notifications.handler';
import { unsubscribeLink } from '@/modules/notification/domain/unsubscribe-link';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { notificationEmailQueuedEvent } from '@/shared/events/notification.events';
import { capturing } from '@/shared/testing/events';
import {
  archiveService,
  createService,
  declareIncident,
  insertConfirmedSubscriber,
  insertDraftIncident,
  insertIncidentUpdate,
  scheduleMaintenance,
  transitionDueMaintenance,
  transitionIncident,
  updateService,
} from '@/shared/testing/fixtures';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';
import { runNotificationPass } from '@/worker';

/**
 * Story 6.6: work out who is owed each public change.
 *
 * Each test has an organization of its own, and every pass is scoped to it
 * with `{ orgIds }`. Subscribers are confirmed a day or more either side of
 * the changes (`insertConfirmedSubscriber`), so whether one is owed never
 * depends on the clock, which steps back on some machines.
 *
 * Sabotage this suite must catch (spec 6.6, AC 4):
 * - removing the overlap branch: "an entry that commits after a later one
 *   was read is owed on the next pass";
 * - removing `for share`: "a pass waits for an unsubscribe in flight";
 * - removing the dismissal clause: "never owes a draft-era entry or a
 *   dismissal";
 * - copying `publishable` into a module: `public-rule-copies.spec.ts`.
 */

const HOUR = 60 * 60 * 1000;
const tag = `owe-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
const created: { orgId: string; userId: string }[] = [];
let counter = 0;
let octet = 0;

// A failure inside the pass is logged here, then surfaces as the pass's
// rejection, since each test's pass visits one organization.
const errors: unknown[] = [];
const logger = {
  info() {},
  warn() {},
  error(obj: unknown) {
    errors.push(obj);
  },
} as unknown as FastifyBaseLogger;

type Org = { cookie: string; orgId: string; slug: string };

async function newOrg(): Promise<Org> {
  counter += 1;
  const slug = `${tag}-${counter}`;
  const { cookie, orgId, userId } = await signUpWithOrg(app, slug);
  created.push({ orgId, userId });
  return { cookie, orgId, slug };
}

// Queueing only: a full pass would go on to send what it queued (story 6.7),
// and these tests read the ledger as the queue left it.
const pass = async (orgId: string): Promise<void> => {
  await app.commandBus.execute(queueEmailNotificationCommand({ orgId }));
};

type Delivery = {
  id: string;
  subscriber_id: string;
  source_type: string;
  source_id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  sent_at: Date | null;
  last_error: string | null;
};

const deliveries = (orgId: string) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<Delivery[]>`
      select id, subscriber_id, source_type, source_id, status, attempts,
             next_attempt_at, sent_at, last_error
      from notification_deliveries
      order by source_type, source_id, subscriber_id
    `,
  );

/** `subscriber:type:source` for each delivery, sorted, for exact comparison. */
const owed = async (orgId: string) =>
  (await deliveries(orgId))
    .map((row) => `${row.subscriber_id}:${row.source_type}:${row.source_id}`)
    .sort();

const expected = (
  pairs: readonly (readonly [string, string, string])[],
): string[] =>
  pairs
    .map(([subscriber, type, source]) => `${subscriber}:${type}:${source}`)
    .sort();

/** Every timeline entry of an incident, in sequence order. */
const entriesOf = (orgId: string, incidentId: string) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<{ id: string; status: string }[]>`
      select id, status from incident_updates
      where incident_id = ${incidentId}
      order by sequence asc
    `,
  );

const cursorOf = async (orgId: string) => {
  const [row] = await withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<{ incident_update_sequence: string }[]>`
      select incident_update_sequence from notification_cursors
    `,
  );
  return row;
};

async function postUpdate(org: Org, incidentId: string, message: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/incidents/${incidentId}/updates`,
    headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    payload: { message },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

async function patchMaintenance(org: Org, id: string, changes: object) {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/v1/maintenance/${id}`,
    headers: { cookie: org.cookie, origin: TEST_ORIGIN },
    payload: changes,
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function maintenanceAction(
  org: Org,
  id: string,
  method: 'POST' | 'DELETE',
  suffix = '',
) {
  const response = await app.inject({
    method,
    url: `/api/v1/maintenance/${id}${suffix}`,
    headers: { cookie: org.cookie, origin: TEST_ORIGIN },
  });
  assert.ok(response.statusCode < 300, response.body);
}

const unsubscribe = (org: Org, subscriberId: string) => {
  octet += 1;
  return app.inject({
    method: 'GET',
    url: unsubscribeLink(
      '',
      org.slug,
      org.orgId,
      subscriberId,
      env.notificationLinkSecret,
    ),
    remoteAddress: `10.66.${(octet >> 8) & 255}.${octet & 255}`,
  });
};

/** Inserts a subscriber in a state no confirm or unsubscribe made. */
const insertSubscriber = (
  orgId: string,
  status: 'pending' | 'unsubscribed',
  confirmedAtOffset: string | null,
) =>
  withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<{ id: string }[]>`
      insert into subscribers (org_id, email, status, confirmed_at)
      values (
        ${orgId}, ${`${randomUUID()}@example.test`}, ${status},
        now() + ${confirmedAtOffset}::interval
      )
      returning id
    `;
    return row.id;
  });

const insertDelivery = (
  orgId: string,
  subscriberId: string,
  status: 'pending' | 'sent',
) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx`
      insert into notification_deliveries (
        org_id, subscriber_id, source_type, source_id, status
      ) values (
        ${orgId}, ${subscriberId}, 'incident_update', ${randomUUID()}, ${status}
      )
    `,
  );

/**
 * Holds a tenant transaction open on its own connection. `work` runs first;
 * the transaction commits once `commit()` is called. `pid` is its backend.
 */
async function holdTransaction(
  orgId: string,
  work: (tx: typeof sql) => Promise<unknown>,
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: (pid: number) => void;
  let failed!: (error: unknown) => void;
  const started = new Promise<number>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = sql.begin(async (raw) => {
    const tx = raw as unknown as typeof sql;
    await tx`select set_config('app.current_org_id', ${orgId}, true)`;
    const [{ pid }] = await tx<
      { pid: number }[]
    >`select pg_backend_pid() as pid`;
    await work(tx);
    ready(pid);
    await released;
  });
  // A failure in `work` must not leave the test waiting for `started`.
  done.catch(failed);
  const pid = await started;
  return {
    pid,
    async commit() {
      release();
      await done;
    },
  };
}

/** Waits until some backend is blocked by `pid`, as `pg_blocking_pids` says. */
async function waitUntilBlockedBy(pid: number, what: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ blocked }] = await sql<{ blocked: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity
        where ${pid} = any(pg_blocking_pids(pid))
      ) as blocked
    `;
    if (blocked) return;
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited on the test's transaction`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('Story 6.6: work out who is owed each public change', () => {
  before(async () => {
    app = await buildApp();
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

  it('owes each confirmed subscriber a posted update, and announces each row by ids', async () => {
    const org = await newOrg();
    const first = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const second = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const incidentId = await declareIncident(app, org.cookie);
    const [declaration] = await entriesOf(org.orgId, incidentId);
    const updateId = await postUpdate(org, incidentId, 'Still looking');

    const { captured } = await capturing(
      app,
      notificationEmailQueuedEvent.type,
      () => pass(org.orgId),
    );

    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [first, 'incident_update', declaration.id],
        [second, 'incident_update', declaration.id],
        [first, 'incident_update', updateId],
        [second, 'incident_update', updateId],
      ]),
    );
    const rows = await deliveries(org.orgId);
    for (const row of rows) {
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, 0);
      assert.ok(row.next_attempt_at instanceof Date);
      assert.equal(row.sent_at, null);
      assert.equal(row.last_error, null);
    }

    // One event per row written, carrying ids only.
    const payloads = captured.map(
      (event) => (event as { payload: Record<string, unknown> }).payload,
    );
    assert.equal(payloads.length, rows.length);
    for (const payload of payloads) {
      assert.deepEqual(Object.keys(payload).sort(), [
        'deliveryId',
        'orgId',
        'sourceId',
        'sourceType',
        'subscriberId',
      ]);
    }
    assert.deepEqual(
      payloads
        .map(
          (p) =>
            `${p.deliveryId}:${p.orgId}:${p.subscriberId}:${p.sourceType}:${p.sourceId}`,
        )
        .sort(),
      rows
        .map(
          (row) =>
            `${row.id}:${org.orgId}:${row.subscriber_id}:${row.source_type}:${row.source_id}`,
        )
        .sort(),
    );
    assert.deepEqual(errors, []);
  });

  it('never owes a draft-era entry or a dismissal, while the public incident beside it is owed', async () => {
    const org = await newOrg();
    const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const publicId = await declareIncident(app, org.cookie);
    const draftId = await insertDraftIncident(org.orgId, {
      title: `${tag} draft`,
      impact: 'major',
    });
    await insertIncidentUpdate(org.orgId, {
      incidentId: draftId,
      status: 'draft',
      message: 'A note on the draft',
      createdAtOffset: '0 seconds',
    });
    // Dismissed: the draft lands on `resolved`, which is not `draft`.
    await transitionIncident(app, org.cookie, draftId, 'resolved');
    const dismissal = (await entriesOf(org.orgId, draftId)).at(-1);
    assert.equal(dismissal?.status, 'resolved');

    await pass(org.orgId);

    const publicEntries = await entriesOf(org.orgId, publicId);
    assert.deepEqual(
      await owed(org.orgId),
      expected(
        publicEntries.map(
          (entry) => [subscriber, 'incident_update', entry.id] as const,
        ),
      ),
    );
    // The cursor passed the dismissal, the last entry, although it is not
    // public: it advances over every row scanned.
    const [{ max }] = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ max: string }[]>`
        select max(sequence)::text as max from incident_updates
      `,
    );
    assert.equal((await cursorOf(org.orgId)).incident_update_sequence, max);
  });

  it('owes a confirmed draft its confirmation and its resolution', async () => {
    const org = await newOrg();
    const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const draftId = await insertDraftIncident(org.orgId, {
      title: `${tag} confirmed draft`,
      impact: 'minor',
    });
    await insertIncidentUpdate(org.orgId, {
      incidentId: draftId,
      status: 'draft',
      message: 'Opened as a draft',
      createdAtOffset: '0 seconds',
    });
    await transitionIncident(app, org.cookie, draftId, 'investigating');
    await transitionIncident(app, org.cookie, draftId, 'resolved');

    await pass(org.orgId);

    const [draftEntry, confirmation, resolution] = await entriesOf(
      org.orgId,
      draftId,
    );
    assert.equal(draftEntry.status, 'draft');
    assert.equal(confirmation.status, 'investigating');
    assert.equal(resolution.status, 'resolved');
    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [subscriber, 'incident_update', confirmation.id],
        [subscriber, 'incident_update', resolution.id],
      ]),
    );
  });

  it('owes nothing about an incident or window naming only hidden services', async () => {
    const org = await newOrg();
    const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const visible = await createService(app, org.cookie);
    const hidden = await createService(app, org.cookie, { isPublic: false });
    const archived = await createService(app, org.cookie);

    const onHidden = await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: hidden, impact: 'minor' }],
    });
    const onArchived = await declareIncident(app, org.cookie, {
      affectedServices: [{ serviceId: archived, impact: 'minor' }],
    });
    const onNone = await declareIncident(app, org.cookie);
    const onVisible = await declareIncident(app, org.cookie, {
      affectedServices: [
        { serviceId: hidden, impact: 'minor' },
        { serviceId: visible, impact: 'minor' },
      ],
    });
    const windowOnHidden = await scheduleMaintenance(app, org.cookie, {
      affectedServiceIds: [hidden],
    });
    const windowOnArchived = await scheduleMaintenance(app, org.cookie, {
      affectedServiceIds: [archived],
    });
    const windowOnNone = await scheduleMaintenance(app, org.cookie);
    const windowOnVisible = await scheduleMaintenance(app, org.cookie, {
      affectedServiceIds: [hidden, visible],
    });
    // Judged on current rows: archived after it was named.
    await archiveService(app, org.cookie, archived);

    await pass(org.orgId);

    const owedEntries = [
      ...(await entriesOf(org.orgId, onNone)),
      ...(await entriesOf(org.orgId, onVisible)),
    ];
    assert.deepEqual(
      await owed(org.orgId),
      expected([
        ...owedEntries.map(
          (entry) => [subscriber, 'incident_update', entry.id] as const,
        ),
        [subscriber, 'maintenance_scheduled', windowOnNone],
        [subscriber, 'maintenance_scheduled', windowOnVisible],
      ]),
    );
    // Not vacuous: the hidden ones were there, and the pass scanned them.
    assert.equal((await entriesOf(org.orgId, onHidden)).length, 1);
    assert.equal((await entriesOf(org.orgId, onArchived)).length, 1);
    const [{ scanned }] = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ scanned: boolean }[]>`
        select bool_and(c.maintenance_read_at >= m.created_at) as scanned
        from notification_cursors c
        cross join maintenance m
        where m.id in (${windowOnHidden}, ${windowOnArchived})
      `,
    );
    assert.equal(scanned, true);
  });

  it('owes nothing to a pending or unsubscribed address, or to one confirmed after the change', async () => {
    const org = await newOrg();
    const confirmedBefore = await insertConfirmedSubscriber(
      org.orgId,
      '-1 day',
    );
    await insertConfirmedSubscriber(org.orgId, '1 day');
    await insertSubscriber(org.orgId, 'pending', null);
    await insertSubscriber(org.orgId, 'unsubscribed', '-1 day');
    const incidentId = await declareIncident(app, org.cookie);
    const [declaration] = await entriesOf(org.orgId, incidentId);

    await pass(org.orgId);

    assert.deepEqual(
      await owed(org.orgId),
      expected([[confirmedBefore, 'incident_update', declaration.id]]),
    );
  });

  describe('a maintenance window', () => {
    it('owes its scheduling, start and completion, one pass at a time', async () => {
      const org = await newOrg();
      const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
      const id = await scheduleMaintenance(app, org.cookie, {
        scheduledStartAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledEndAt: new Date(Date.now() + HOUR).toISOString(),
      });
      await pass(org.orgId);
      assert.deepEqual(
        await owed(org.orgId),
        expected([[subscriber, 'maintenance_scheduled', id]]),
      );

      await transitionDueMaintenance(app, org.orgId);
      await pass(org.orgId);
      await maintenanceAction(org, id, 'POST', '/complete');
      await pass(org.orgId);

      assert.deepEqual(
        await owed(org.orgId),
        expected([
          [subscriber, 'maintenance_scheduled', id],
          [subscriber, 'maintenance_started', id],
          [subscriber, 'maintenance_completed', id],
        ]),
      );
    });

    it('owes two changes for a window that went straight to completed', async () => {
      const org = await newOrg();
      const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
      const id = await scheduleMaintenance(app, org.cookie, {
        scheduledStartAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        scheduledEndAt: new Date(Date.now() - HOUR).toISOString(),
      });
      await transitionDueMaintenance(app, org.orgId);

      await pass(org.orgId);

      assert.deepEqual(
        await owed(org.orgId),
        expected([
          [subscriber, 'maintenance_scheduled', id],
          [subscriber, 'maintenance_completed', id],
        ]),
      );
    });

    it('owes nothing for an edit, or for a window deleted before the pass', async () => {
      const org = await newOrg();
      const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
      const edited = await scheduleMaintenance(app, org.cookie);
      await pass(org.orgId);
      await patchMaintenance(org, edited, {
        title: `${tag} edited`,
        scheduledEndAt: new Date(Date.now() + 3 * HOUR).toISOString(),
      });
      const deleted = await scheduleMaintenance(app, org.cookie);
      await maintenanceAction(org, deleted, 'DELETE');

      await pass(org.orgId);

      assert.deepEqual(
        await owed(org.orgId),
        expected([[subscriber, 'maintenance_scheduled', edited]]),
      );
    });

    it('reads each of its changes on its own, so one does not bring back another', async () => {
      const org = await newOrg();
      const subscriber = await insertConfirmedSubscriber(org.orgId, '-2 days');
      const hidden = await createService(app, org.cookie, { isPublic: false });
      const id = await scheduleMaintenance(app, org.cookie, {
        scheduledStartAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledEndAt: new Date(Date.now() + HOUR).toISOString(),
        affectedServiceIds: [hidden],
      });
      // Scheduled a day ago, so outside any overlap once the cursor has it.
      await withTenantTransaction(org.orgId, async ({ sql: tx }) => {
        await tx`
          update maintenance set created_at = now() - interval '1 day'
          where id = ${id}
        `;
      });
      // Read while every service it names is hidden: owed to no one.
      await pass(org.orgId);
      assert.deepEqual(await owed(org.orgId), []);

      // Made public, then started. The start is owed; the scheduling, read
      // once already and long past the overlap, is not read again.
      await updateService(app, org.cookie, hidden, { isPublic: true });
      await transitionDueMaintenance(app, org.orgId);
      await pass(org.orgId);

      assert.deepEqual(
        await owed(org.orgId),
        expected([[subscriber, 'maintenance_started', id]]),
      );
    });
  });

  it('reads the whole history on the first pass, owing what came after each confirmation', async () => {
    const org = await newOrg();
    const longAgo = await insertConfirmedSubscriber(org.orgId, '-3 days');
    const yesterday = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const incidentId = await declareIncident(app, org.cookie);
    await insertIncidentUpdate(org.orgId, {
      incidentId,
      status: 'investigating',
      message: 'Recorded two days ago',
      createdAtOffset: '-2 days',
    });
    const [declaration, old] = await entriesOf(org.orgId, incidentId);
    const windowId = await scheduleMaintenance(app, org.cookie);
    await withTenantTransaction(org.orgId, async ({ sql: tx }) => {
      await tx`
        update maintenance set created_at = now() - interval '2 days'
        where id = ${windowId}
      `;
    });

    await pass(org.orgId);

    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [longAgo, 'incident_update', declaration.id],
        [longAgo, 'incident_update', old.id],
        [longAgo, 'maintenance_scheduled', windowId],
        [yesterday, 'incident_update', declaration.id],
      ]),
    );
  });

  it('owes a window start that commits after a later change was read, on the next pass', async () => {
    const org = await newOrg();
    const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const a = await scheduleMaintenance(app, org.cookie);

    // Window A's start is stamped now and commits only later.
    const held = await holdTransaction(org.orgId, async (tx) => {
      await tx`
        update maintenance
        set status = 'in_progress', started_at = now(), updated_at = now()
        where id = ${a}
      `;
    });
    let b: string;
    try {
      // Window B is scheduled after it and commits first, and the pass reads
      // it, which moves the cursor past A's start.
      b = await scheduleMaintenance(app, org.cookie);
      await pass(org.orgId);
    } finally {
      await held.commit();
    }
    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [subscriber, 'maintenance_scheduled', a],
        [subscriber, 'maintenance_scheduled', b],
      ]),
    );

    // Only the overlap can find A's start now.
    await pass(org.orgId);

    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [subscriber, 'maintenance_scheduled', a],
        [subscriber, 'maintenance_scheduled', b],
        [subscriber, 'maintenance_started', a],
      ]),
    );
  });

  it('writes nothing new on a repeat pass', async () => {
    const org = await newOrg();
    await insertConfirmedSubscriber(org.orgId, '-1 day');
    await declareIncident(app, org.cookie);
    await scheduleMaintenance(app, org.cookie);
    await pass(org.orgId);
    const first = await owed(org.orgId);
    assert.equal(first.length, 2);

    const { captured } = await capturing(
      app,
      notificationEmailQueuedEvent.type,
      () => pass(org.orgId),
    );
    assert.deepEqual(await owed(org.orgId), first);
    assert.equal(captured.length, 0);
  });

  it('owes an entry that commits after a later one was read, on the next pass', async () => {
    const org = await newOrg();
    const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const incidentId = await declareIncident(app, org.cookie);
    const [declaration] = await entriesOf(org.orgId, incidentId);

    // Entry N takes its sequence now and commits only later.
    const held = await holdTransaction(org.orgId, async (tx) => {
      await tx`
        insert into incident_updates (org_id, incident_id, status, message)
        values (${org.orgId}, ${incidentId}, 'investigating', 'N')
      `;
    });
    try {
      // Entry N + 1 commits first, and the pass reads it.
      await insertIncidentUpdate(org.orgId, {
        incidentId,
        status: 'investigating',
        message: 'N + 1',
        createdAtOffset: '0 seconds',
      });
      await pass(org.orgId);
    } finally {
      await held.commit();
    }
    const entries = await entriesOf(org.orgId, incidentId);
    const byMessage = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) => tx<{ id: string; message: string }[]>`
        select id, message from incident_updates
        where incident_id = ${incidentId} and message in ('N', 'N + 1')
      `,
    );
    const n = byMessage.find((row) => row.message === 'N')?.id;
    const nPlusOne = byMessage.find((row) => row.message === 'N + 1')?.id;
    assert.ok(n && nPlusOne);
    // Sequence order is N, then N + 1, though N + 1 committed first.
    assert.deepEqual(
      entries.map((entry) => entry.id),
      [declaration.id, n, nPlusOne],
    );
    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [subscriber, 'incident_update', declaration.id],
        [subscriber, 'incident_update', nPlusOne],
      ]),
    );

    // The cursor is past N, so only the overlap can find it.
    await pass(org.orgId);

    assert.deepEqual(
      await owed(org.orgId),
      expected([
        [subscriber, 'incident_update', declaration.id],
        [subscriber, 'incident_update', n],
        [subscriber, 'incident_update', nPlusOne],
      ]),
    );
  });

  it('records one organization s failure and carries on, rejecting only when every one fails', async () => {
    const org = await newOrg();
    const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
    const incidentId = await declareIncident(app, org.cookie);
    const [declaration] = await entriesOf(org.orgId, incidentId);
    const bad = 'not a valid id!';

    errors.length = 0;
    await runNotificationPass(app, logger, { orgIds: [bad, org.orgId] });
    // Once each for queueing, the prune (story 6.9) and dispatch, which
    // visits it too (story 6.7): its earlier rows would still be owed.
    assert.equal(errors.length, 3, 'the bad organization is logged');
    for (const entry of errors) {
      assert.equal((entry as { orgId: string }).orgId, bad);
    }
    assert.deepEqual(
      await owed(org.orgId),
      expected([[subscriber, 'incident_update', declaration.id]]),
    );

    errors.length = 0;
    await assert.rejects(
      runNotificationPass(app, logger, { orgIds: [bad] }),
      (error: Error) => {
        assert.equal(error.message, 'every organization failed (1)');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    errors.length = 0;
  });

  describe('unsubscribing', () => {
    it('removes every pending delivery, on either outcome, and keeps the rest', async () => {
      const org = await newOrg();
      const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');
      const other = await insertConfirmedSubscriber(org.orgId, '-1 day');
      await declareIncident(app, org.cookie);
      await scheduleMaintenance(app, org.cookie);
      await pass(org.orgId);
      await insertDelivery(org.orgId, subscriber, 'sent');
      const pendingOf = async (id: string) =>
        (await deliveries(org.orgId)).filter(
          (row) => row.subscriber_id === id && row.status === 'pending',
        ).length;
      assert.equal(await pendingOf(subscriber), 2);

      const response = await unsubscribe(org, subscriber);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(await pendingOf(subscriber), 0);
      assert.equal(
        await pendingOf(other),
        2,
        'another subscriber keeps theirs',
      );
      const kept = (await deliveries(org.orgId)).filter(
        (row) => row.subscriber_id === subscriber,
      );
      assert.deepEqual(
        kept.map((row) => row.status),
        ['sent'],
      );

      // Already unsubscribed: the `unchanged` outcome deletes too.
      await insertDelivery(org.orgId, subscriber, 'pending');
      const again = await unsubscribe(org, subscriber);
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(await pendingOf(subscriber), 0);
    });

    it('makes a pass wait for an unsubscribe in flight, which then owes that subscriber nothing', async () => {
      const org = await newOrg();
      const leaving = await insertConfirmedSubscriber(org.orgId, '-1 day');
      const staying = await insertConfirmedSubscriber(org.orgId, '-1 day');
      const incidentId = await declareIncident(app, org.cookie);
      const [declaration] = await entriesOf(org.orgId, incidentId);

      // The unsubscribe's UPDATE, run and not yet committed.
      const held = await holdTransaction(org.orgId, async (tx) => {
        await tx`
          update subscribers set status = 'unsubscribed', updated_at = now()
          where id = ${leaving}
        `;
      });
      let running: Promise<void> | undefined;
      try {
        running = pass(org.orgId);
        await waitUntilBlockedBy(held.pid, 'the pass');
      } finally {
        await held.commit();
        await running?.catch(() => undefined);
      }
      await running;

      assert.deepEqual(
        await owed(org.orgId),
        expected([[staying, 'incident_update', declaration.id]]),
      );
    });

    it('waits for a pass in flight, then removes what it wrote', async () => {
      const org = await newOrg();
      const subscriber = await insertConfirmedSubscriber(org.orgId, '-1 day');

      // What a pass does: lock the subscriber `for share`, write a pending
      // delivery, and not yet commit.
      const held = await holdTransaction(org.orgId, async (tx) => {
        await tx`select id from subscribers where id = ${subscriber} for share`;
        await tx`
          insert into notification_deliveries (
            org_id, subscriber_id, source_type, source_id, status
          ) values (
            ${org.orgId}, ${subscriber}, 'incident_update', ${randomUUID()},
            'pending'
          )
        `;
      });
      let running: ReturnType<typeof unsubscribe> | undefined;
      try {
        running = unsubscribe(org, subscriber);
        await waitUntilBlockedBy(held.pid, 'the unsubscribe');
      } finally {
        await held.commit();
      }
      const response = await running;
      assert.equal(response?.statusCode, 200, response?.body);

      assert.deepEqual(
        (await deliveries(org.orgId)).filter((row) => row.status === 'pending'),
        [],
      );
    });
  });
});
