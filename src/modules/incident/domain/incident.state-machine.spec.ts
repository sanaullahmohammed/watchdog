import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allowedTransitions,
  allTransitionPairs,
  assertTransition,
  canTransition,
  InvalidIncidentTransitionError,
  resolutionEventName,
} from '@/modules/incident/domain/incident.state-machine';
import {
  INCIDENT_STATUSES,
  type IncidentStatus,
} from '@/modules/incident/domain/incident.types';

/**
 * Story 2.7 — the incident lifecycle.
 *
 * Derived from FR6's verification line, "State-machine tests cover valid and
 * invalid transitions", and from DOMAIN.md's allowed-transition table, which
 * is the rule the line summarises.
 */

/** DOMAIN.md's table, restated here so the test fails if the code drifts from it. */
const DOMAIN_TABLE: ReadonlyArray<readonly [string, IncidentStatus]> = [
  ['[none]', 'draft'],
  ['[none]', 'investigating'],
  ['draft', 'investigating'],
  ['draft', 'resolved'],
  ['investigating', 'identified'],
  ['investigating', 'monitoring'],
  ['investigating', 'resolved'],
  ['identified', 'monitoring'],
  ['identified', 'resolved'],
  ['monitoring', 'resolved'],
];

const label = (from: string | null) => from ?? '[none]';

describe('incident state machine', () => {
  it('has no dismissed status; the ladder is exactly DOMAIN.md s five', () => {
    assert.deepEqual(
      [...INCIDENT_STATUSES],
      ['draft', 'investigating', 'identified', 'monitoring', 'resolved'],
    );
  });

  it('accepts exactly the transitions DOMAIN.md allows', () => {
    const implemented = allowedTransitions().map(
      ([from, to]) => `${label(from)} -> ${to}`,
    );
    const documented = DOMAIN_TABLE.map(([from, to]) => `${from} -> ${to}`);

    assert.deepEqual([...implemented].sort(), [...documented].sort());
  });

  it('rejects every ordered pair the table does not list', () => {
    const documented = new Set(
      DOMAIN_TABLE.map(([from, to]) => `${from} -> ${to}`),
    );

    // Exhaustive: six origins including creation, five destinations, thirty
    // pairs. Ten legal, twenty rejected.
    const pairs = allTransitionPairs();
    assert.equal(pairs.length, 30, 'the sweep must cover every ordered pair');

    const accepted: string[] = [];
    const rejected: string[] = [];

    for (const [from, to] of pairs) {
      const key = `${label(from)} -> ${to}`;
      (canTransition(from, to) ? accepted : rejected).push(key);
      assert.equal(
        canTransition(from, to),
        documented.has(key),
        `${key} disagrees with DOMAIN.md`,
      );
    }

    assert.equal(accepted.length, 10);
    assert.equal(rejected.length, 20);
  });

  it('treats resolved as terminal', () => {
    for (const to of INCIDENT_STATUSES) {
      assert.equal(
        canTransition('resolved', to),
        false,
        `resolved -> ${to} must be rejected, including resolved -> resolved`,
      );
    }
  });

  it('refuses to skip the confirmation step for a draft', () => {
    // A draft may be confirmed into investigating or dismissed. It may not jump
    // straight to identified or monitoring, which would put a monitor-generated
    // incident in front of customers without a human ever confirming it.
    assert.equal(canTransition('draft', 'identified'), false);
    assert.equal(canTransition('draft', 'monitoring'), false);
    assert.equal(canTransition('draft', 'draft'), false);
  });

  it('throws a domain error naming both ends of an illegal move', () => {
    assert.throws(
      () => assertTransition('resolved', 'investigating'),
      (error: Error) => {
        assert.ok(error instanceof InvalidIncidentTransitionError);
        assert.match(error.message, /resolved to investigating/);
        return true;
      },
    );

    assert.doesNotThrow(() => assertTransition('investigating', 'identified'));
    assert.doesNotThrow(() => assertTransition(null, 'draft'));
  });

  it('announces a dismissed draft as dismissed, never as resolved', () => {
    // Both land on `resolved` because the ladder has no `dismissed` status, but
    // a dismissed draft describes an outage that never happened and that
    // customers were never told about. ARCHITECTURE.md 5.4 reserves
    // incident.resolved for the public lifecycle.
    assert.equal(resolutionEventName('draft'), 'incident.dismissed');

    for (const from of ['investigating', 'identified', 'monitoring'] as const) {
      assert.equal(resolutionEventName(from), 'incident.resolved');
    }
  });
});
