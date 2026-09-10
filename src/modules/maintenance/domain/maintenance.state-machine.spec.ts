import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  InvalidMaintenanceTransitionError,
  type MaintenanceStatusOrNew,
} from '@/modules/maintenance/domain/maintenance.state-machine';
import {
  MAINTENANCE_STATUSES,
  type MaintenanceStatus,
} from '@/modules/maintenance/domain/maintenance.types';

/** DOMAIN.md's table, restated so the test fails if the code drifts from it. */
const DOMAIN_TABLE: ReadonlyArray<readonly [string, MaintenanceStatus]> = [
  ['[none]', 'scheduled'],
  ['scheduled', 'in_progress'],
  ['scheduled', 'completed'],
  ['in_progress', 'completed'],
];

const label = (from: MaintenanceStatusOrNew) => from ?? '[none]';

describe('maintenance state machine', () => {
  it('accepts exactly the transitions DOMAIN.md allows', () => {
    assert.deepEqual(
      allowedTransitions()
        .map(([from, to]) => `${label(from)} -> ${to}`)
        .sort(),
      DOMAIN_TABLE.map(([from, to]) => `${from} -> ${to}`).sort(),
    );
  });

  it('rejects every ordered pair the table does not list', () => {
    const documented = new Set(
      DOMAIN_TABLE.map(([from, to]) => `${from} -> ${to}`),
    );
    const origins: MaintenanceStatusOrNew[] = [null, ...MAINTENANCE_STATUSES];

    let accepted = 0;
    for (const from of origins) {
      for (const to of MAINTENANCE_STATUSES) {
        const key = `${label(from)} -> ${to}`;
        assert.equal(canTransition(from, to), documented.has(key), key);
        if (documented.has(key)) accepted += 1;
      }
    }

    // Four origins, three destinations, twelve pairs; four legal.
    assert.equal(accepted, 4);
  });

  it('treats completed as terminal and refuses to reopen a window', () => {
    for (const to of MAINTENANCE_STATUSES) {
      assert.equal(canTransition('completed', to), false, `completed -> ${to}`);
    }
    // Including back to in_progress: work that finished did finish.
    assert.equal(canTransition('completed', 'in_progress'), false);
  });

  it('will not skip a window straight from creation to running', () => {
    assert.equal(canTransition(null, 'in_progress'), false);
    assert.equal(canTransition(null, 'completed'), false);
  });

  it('throws a domain error naming both ends', () => {
    assert.throws(
      () => assertTransition('completed', 'scheduled'),
      InvalidMaintenanceTransitionError,
    );
    assert.doesNotThrow(() => assertTransition('scheduled', 'completed'));
  });
});
