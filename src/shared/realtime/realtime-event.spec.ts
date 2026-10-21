import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { CommandCreator } from '@/shared/cqrs/bus.types';
import * as incidentEvents from '@/shared/events/incident.events';
import * as maintenanceEvents from '@/shared/events/maintenance.events';
import * as monitorEvents from '@/shared/events/monitor.events';
import * as serviceEvents from '@/shared/events/service.events';
import * as subscriberEvents from '@/shared/events/subscriber.events';
import {
  BRIDGED_EVENT_NAMES,
  BRIDGED_EVENTS,
  NOTIFY_CHANNEL,
  toRealtimeEvent,
  toWireName,
} from '@/shared/realtime/realtime-event';

/**
 * Story 4.3: which domain events cross processes, and what they carry.
 *
 * Needs no database; runs with the unit suite.
 */

/**
 * DOMAIN.md's canonical event catalog, its "Bridge to LISTEN/NOTIFY" column,
 * restated here so the test fails if the code drifts from it.
 */
const DOMAIN_CATALOG: ReadonlyArray<
  readonly [string, 'Yes' | 'No' | 'Optional']
> = [
  ['service.status_changed', 'Yes'],
  ['service.created', 'Yes'],
  ['service.updated', 'Yes'],
  ['service.archived', 'Yes'],
  ['service.restored', 'Yes'],
  ['service.manual_override_set', 'Yes'],
  ['service.manual_override_cleared', 'Yes'],
  ['service_group.created', 'Yes'],
  ['service_group.updated', 'Yes'],
  ['service_group.deleted', 'Yes'],
  ['incident.created', 'Yes'],
  ['incident.draft_created', 'Yes'],
  ['incident.confirmed', 'Yes'],
  ['incident.updated', 'Yes'],
  ['incident.update_posted', 'Yes'],
  ['incident.state_changed', 'Yes'],
  ['incident.resolved', 'Yes'],
  ['incident.dismissed', 'Yes'],
  ['maintenance.created', 'Yes'],
  ['maintenance.updated', 'Yes'],
  ['maintenance.started', 'Yes'],
  ['maintenance.completed', 'Yes'],
  ['maintenance.deleted', 'Yes'],
  ['monitor.created', 'No'],
  ['monitor.updated', 'No'],
  ['monitor.deleted', 'No'],
  ['monitor.check_succeeded', 'Optional'],
  ['monitor.check_failed', 'Optional'],
  ['monitor.state_changed', 'Optional'],
  ['monitor.recovered', 'Yes'],
  ['monitor.threshold_breached', 'Yes'],
  ['monitor.ssl_expiry_warning', 'Yes'],
  ['uptime.rollup_refreshed', 'Optional'],
  ['subscriber.created', 'No'],
  ['subscriber.confirmed', 'No'],
  ['subscriber.unsubscribed', 'No'],
  ['notification.email_queued', 'No'],
  ['notification.email_sent', 'No'],
  ['notification.email_failed', 'No'],
  ['ai.incident_update_drafted', 'No'],
  ['ai.postmortem_drafted', 'No'],
  ['ai.weekly_digest_drafted', 'No'],
  ['ai.nl_query_answered', 'No'],
];

/** The one "Optional" event ARCHITECTURE.md 5.3 bridges. */
const BRIDGED_OPTIONAL = ['uptime.rollup_refreshed'];

/** Every creator `src/shared/events/` exports, by its export name. */
const EXPORTED_CREATORS: ReadonlyMap<string, CommandCreator<unknown>> = new Map(
  [
    incidentEvents,
    maintenanceEvents,
    monitorEvents,
    serviceEvents,
    subscriberEvents,
  ].flatMap((module) =>
    Object.entries(module).filter(
      (entry): entry is [string, CommandCreator<unknown>] =>
        typeof entry[1] === 'function' &&
        typeof (entry[1] as { type?: unknown }).type === 'string',
    ),
  ),
);

/** The event modules imported above. A new one must be added there, and to the catalog checks. */
const IMPORTED_EVENT_FILES = [
  'incident.events.ts',
  'maintenance.events.ts',
  'monitor.events.ts',
  'service.events.ts',
  'subscriber.events.ts',
];

const EVENTS_ROOT = join(__dirname, '../events');
const MODULES_ROOT = join(__dirname, '../../modules');

/** Every non-test source file under `src/modules`. */
function moduleSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return moduleSources(path);
    if (!entry.name.endsWith('.ts')) return [];
    if (/\.(test|spec)\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

/**
 * The file's code with its imports and comments removed, so naming a creator
 * in either does not count as using it. Parsed and reprinted with the
 * TypeScript compiler rather than cut by a pattern, so a side-effect import
 * (`import 'x';`) or a `//` inside a string is handled like any other.
 */
function codeWithoutImports(path: string): string {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const withoutImports = ts.factory.updateSourceFile(
    source,
    source.statements.filter(
      (statement) =>
        !ts.isImportDeclaration(statement) &&
        !ts.isImportEqualsDeclaration(statement),
    ),
  );
  return ts.createPrinter({ removeComments: true }).printFile(withoutImports);
}

const SOURCES = moduleSources(MODULES_ROOT).map((path) => ({
  path,
  text: codeWithoutImports(path),
}));

/**
 * Where a creator is emitted. In a command handler, any use of the creator
 * beyond its import counts, which covers the ternary that picks
 * `incidentDismissedEvent` or `incidentResolvedEvent` before one emit.
 *
 * A subscriber (`*.event-handler.ts`) names the creators it listens to, in a
 * trigger list or by `.type`, and that is not an emit. Its file counts only
 * where it calls `emit(creator(`, which is how the status recomputation
 * subscriber emits `service.status_changed`, its only emit site.
 */
function emitSitesOf(exportName: string): string[] {
  const used = new RegExp(`\\b${exportName}\\b`);
  const emitted = new RegExp(`\\bemit\\(\\s*${exportName}\\(`);
  return SOURCES.filter(({ path, text }) =>
    path.endsWith('.event-handler.ts') ? emitted.test(text) : used.test(text),
  ).map(({ path }) => relative(MODULES_ROOT, path));
}

function exportNameOf(creator: { readonly type: string }): string | undefined {
  for (const [name, exported] of EXPORTED_CREATORS) {
    if (exported === creator) return name;
  }
  return undefined;
}

const TIMESTAMP = Date.UTC(2026, 9, 18, 12, 0, 0);
const ORG_ID = 'org_0123456789abcdef0123456789ab';
const KEYS = [
  'aggregateId',
  'aggregateType',
  'eventName',
  'occurredAt',
  'orgId',
  'version',
];

describe('Story 4.3: the bridged event set', () => {
  it('is exactly DOMAIN.md s "Yes" events plus uptime.rollup_refreshed', () => {
    const documented = [
      ...DOMAIN_CATALOG.filter(([, bridge]) => bridge === 'Yes').map(
        ([name]) => name,
      ),
      ...BRIDGED_OPTIONAL,
    ];

    assert.deepEqual([...BRIDGED_EVENT_NAMES].sort(), documented.sort());
    assert.equal(
      new Set(BRIDGED_EVENT_NAMES).size,
      BRIDGED_EVENT_NAMES.length,
      'no event is bridged twice',
    );
  });

  it('bridges nothing DOMAIN.md marks "No", and no other "Optional" event', () => {
    const bridged = new Set(BRIDGED_EVENT_NAMES);
    for (const [name, bridge] of DOMAIN_CATALOG) {
      if (bridge === 'Yes' || BRIDGED_OPTIONAL.includes(name)) continue;
      assert.equal(bridged.has(name), false, `${name} is ${bridge}`);
    }
  });

  it('names every bridged event by a creator src/shared/events/ exports', () => {
    const exportedTypes = new Set(
      [...EXPORTED_CREATORS.values()].map((creator) => creator.type),
    );
    for (const { creator } of BRIDGED_EVENTS) {
      assert.ok(
        exportedTypes.has(creator.type),
        `${creator.type} is not a creator exported from src/shared/events/`,
      );
      assert.ok(exportNameOf(creator), `${creator.type} has no export name`);
    }
  });

  it('reads every event file in src/shared/events/', () => {
    const files = readdirSync(EVENTS_ROOT)
      .filter((name) => name.endsWith('.events.ts'))
      .sort();
    assert.deepEqual(
      files,
      IMPORTED_EVENT_FILES,
      'a new event file escapes the catalog checks until this spec imports it',
    );
  });

  it('knows every exported event: each is in the restated catalog', () => {
    const catalog = new Set(DOMAIN_CATALOG.map(([name]) => name));
    for (const [name, creator] of EXPORTED_CREATORS) {
      assert.ok(
        catalog.has(toWireName(creator.type)),
        `${name} (${creator.type}) is not in DOMAIN.md's catalog`,
      );
    }
  });

  it('bridges only events that something in src/modules emits', () => {
    // Not vacuous: the reader must find files, and must tell a subscriber's
    // reference from an emit.
    assert.ok(SOURCES.length > 0, 'no source files were read');
    assert.deepEqual(
      emitSitesOf('monitorThresholdBreachedEvent').filter((path) =>
        path.endsWith('.event-handler.ts'),
      ),
      [],
      'subscribing to an event is not emitting it',
    );

    for (const { creator } of BRIDGED_EVENTS) {
      const name = exportNameOf(creator) as string;
      assert.notDeepEqual(
        emitSitesOf(name),
        [],
        `${name} is bridged, but nothing in src/modules emits it`,
      );
    }
  });

  it('translates the bus name to the dotted wire name', () => {
    assert.equal(toWireName('incident/created'), 'incident.created');
    assert.equal(toWireName('service_group/deleted'), 'service_group.deleted');
    assert.equal(NOTIFY_CHANNEL, 'watchdog_events');
  });
});

describe('Story 4.3: toRealtimeEvent', () => {
  const meta = { timestamp: TIMESTAMP, correlationId: 'req-1' };

  it('sends an incident event as the incident, and nothing else of its payload', () => {
    const id = '0f6a3a8e-62f4-4c4b-9a1d-0d4d8c7f0a11';
    const event = toRealtimeEvent({
      ...incidentEvents.incidentUpdatePostedEvent(
        { id, orgId: ORG_ID, updateId: 'u-1' },
        meta,
      ),
      // Fields the creator's type does not have must not leak either.
      payload: {
        id,
        orgId: ORG_ID,
        updateId: 'u-1',
        title: 'Checkout is failing',
        message: 'We are investigating.',
      },
    });

    assert.deepEqual(Object.keys(event).sort(), KEYS);
    assert.deepEqual(event, {
      eventName: 'incident.update_posted',
      orgId: ORG_ID,
      aggregateType: 'incident',
      aggregateId: id,
      occurredAt: new Date(TIMESTAMP).toISOString(),
      version: 1,
    });
  });

  it('sends a monitor event as the monitor, by monitorId', () => {
    const event = toRealtimeEvent(
      monitorEvents.monitorThresholdBreachedEvent(
        {
          orgId: ORG_ID,
          monitorId: 'monitor-1',
          serviceId: 'service-1',
          monitorName: 'Checkout health',
          failureEpisode: 3,
        },
        meta,
      ),
    );

    assert.deepEqual(Object.keys(event).sort(), KEYS);
    assert.deepEqual(event, {
      eventName: 'monitor.threshold_breached',
      orgId: ORG_ID,
      aggregateType: 'monitor',
      aggregateId: 'monitor-1',
      occurredAt: new Date(TIMESTAMP).toISOString(),
      version: 1,
    });
  });

  it('sends a rollup refresh as the organization', () => {
    const event = toRealtimeEvent(
      monitorEvents.uptimeRollupRefreshedEvent(
        {
          orgId: ORG_ID,
          from: '2026-10-01',
          through: '2026-10-18',
          written: 4,
          pruned: 1,
        },
        meta,
      ),
    );

    assert.deepEqual(Object.keys(event).sort(), KEYS);
    assert.deepEqual(event, {
      eventName: 'uptime.rollup_refreshed',
      orgId: ORG_ID,
      aggregateType: 'organization',
      aggregateId: ORG_ID,
      occurredAt: new Date(TIMESTAMP).toISOString(),
      version: 1,
    });
  });

  it('names the aggregate by the event prefix, service_group included', () => {
    const event = toRealtimeEvent(
      serviceEvents.serviceGroupDeletedEvent(
        { id: 'group-1', orgId: ORG_ID, slug: 'core' },
        meta,
      ),
    );
    assert.equal(event.aggregateType, 'service_group');
    assert.equal(event.aggregateId, 'group-1');
  });

  it('refuses an event the bus never stamped, rather than inventing a time', () => {
    assert.throws(
      () =>
        toRealtimeEvent(
          incidentEvents.incidentCreatedEvent({ id: 'i-1', orgId: ORG_ID }),
        ),
      /meta\.timestamp/,
    );
    assert.throws(
      () =>
        toRealtimeEvent(
          incidentEvents.incidentCreatedEvent(
            { id: 'i-1', orgId: ORG_ID },
            { correlationId: 'req-1' },
          ),
        ),
      /meta\.timestamp/,
    );
  });

  it('refuses an event that names no organization', () => {
    assert.throws(
      () =>
        toRealtimeEvent({
          type: incidentEvents.incidentCreatedEvent.type,
          payload: { id: 'i-1' },
          meta,
        }),
      /names no orgId/,
    );
    assert.throws(
      () =>
        toRealtimeEvent(
          incidentEvents.incidentCreatedEvent({ id: 'i-1', orgId: '' }, meta),
        ),
      /names no orgId/,
    );
  });

  it('refuses an event that is not bridged', () => {
    assert.throws(
      () =>
        toRealtimeEvent(
          monitorEvents.monitorCreatedEvent(
            {
              orgId: ORG_ID,
              monitorId: 'monitor-1',
              serviceId: 'service-1',
              monitorName: 'Checkout health',
            },
            meta,
          ),
        ),
      /not a bridged event/,
    );
  });
});
