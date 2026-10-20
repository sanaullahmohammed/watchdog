import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPublicEvent,
  PUBLIC_EVENT_NAMES,
} from '@/shared/realtime/event-visibility';
import { BRIDGED_EVENT_NAMES } from '@/shared/realtime/realtime-event';

/**
 * Story 4.4: which bridged events may reach a public subscriber.
 *
 * Needs no database; runs with the unit suite.
 */

type Visibility = 'Public' | 'Public, draft-gated' | 'Admin-only';

/**
 * DOMAIN.md's canonical event catalog, its Visibility column, for every
 * bridged event, restated here so the test fails if the code drifts from it.
 */
const DOMAIN_VISIBILITY: ReadonlyArray<readonly [string, Visibility]> = [
  ['service.status_changed', 'Public'],
  ['service.created', 'Public'],
  ['service.updated', 'Public'],
  ['service.archived', 'Public'],
  ['service.restored', 'Public'],
  ['service.manual_override_set', 'Admin-only'],
  ['service.manual_override_cleared', 'Admin-only'],
  ['service_group.created', 'Public'],
  ['service_group.updated', 'Public'],
  ['service_group.deleted', 'Public'],
  ['incident.created', 'Public, draft-gated'],
  ['incident.draft_created', 'Admin-only'],
  ['incident.confirmed', 'Public'],
  ['incident.updated', 'Public, draft-gated'],
  ['incident.update_posted', 'Public, draft-gated'],
  ['incident.state_changed', 'Admin-only'],
  ['incident.resolved', 'Public'],
  ['incident.dismissed', 'Admin-only'],
  ['maintenance.created', 'Public'],
  ['maintenance.updated', 'Public'],
  ['maintenance.started', 'Public'],
  ['maintenance.completed', 'Public'],
  ['maintenance.deleted', 'Public'],
  ['monitor.recovered', 'Admin-only'],
  ['monitor.threshold_breached', 'Admin-only'],
  ['monitor.ssl_expiry_warning', 'Admin-only'],
  ['uptime.rollup_refreshed', 'Admin-only'],
];

/** Admin-only by DOMAIN, named one by one so a slip onto the whitelist is obvious. */
const NEVER_PUBLIC = [
  'service.manual_override_set',
  'service.manual_override_cleared',
  'incident.draft_created',
  'incident.state_changed',
  'incident.dismissed',
  'monitor.recovered',
  'monitor.threshold_breached',
  'monitor.ssl_expiry_warning',
  'uptime.rollup_refreshed',
];

describe('Story 4.4: the public event whitelist', () => {
  it('restates the Visibility of exactly the bridged events', () => {
    assert.equal(DOMAIN_VISIBILITY.length, 27);
    assert.deepEqual(
      DOMAIN_VISIBILITY.map(([name]) => name).sort(),
      [...BRIDGED_EVENT_NAMES].sort(),
    );
  });

  it('is exactly DOMAIN.md s "Public" and "Public, draft-gated" events', () => {
    const documented = DOMAIN_VISIBILITY.filter(
      ([, visibility]) => visibility !== 'Admin-only',
    ).map(([name]) => name);

    assert.deepEqual([...PUBLIC_EVENT_NAMES].sort(), documented.sort());
    assert.equal(PUBLIC_EVENT_NAMES.size, 18);
  });

  it('leaves out every admin-only event', () => {
    for (const name of NEVER_PUBLIC) {
      assert.equal(isPublicEvent(name), false, `${name} is admin-only`);
    }
    for (const name of BRIDGED_EVENT_NAMES) {
      if (name.startsWith('monitor.') || name.startsWith('uptime.')) {
        assert.equal(isPublicEvent(name), false, `${name} is admin-only`);
      }
    }
    assert.deepEqual(
      DOMAIN_VISIBILITY.filter(([, visibility]) => visibility === 'Admin-only')
        .map(([name]) => name)
        .sort(),
      [...NEVER_PUBLIC].sort(),
    );
  });

  it('admits only bridged events, and matches isPublicEvent', () => {
    const bridged = new Set(BRIDGED_EVENT_NAMES);
    for (const name of PUBLIC_EVENT_NAMES) {
      assert.ok(bridged.has(name), `${name} is not bridged`);
      assert.equal(isPublicEvent(name), true);
    }
    assert.equal(isPublicEvent('monitor.created'), false);
    assert.equal(isPublicEvent(''), false);
  });
});
