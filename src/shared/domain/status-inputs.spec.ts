import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_INCIDENT_STATUSES,
  INCIDENT_STATUSES,
} from '@/shared/domain/status-inputs';

/**
 * Epic 3 retrospective, action item 14 (AV-3): "active incident" is one
 * definition, and it is the one DOMAIN describes. Two readers depend on it —
 * the status recomputation and the public page — so a value added here changes
 * both what moves a service's status and what a customer sees.
 */

describe('ACTIVE_INCIDENT_STATUSES', () => {
  it('is a subset of the incident ladder', () => {
    // A typo would otherwise match no row, silently: every incident would look
    // inactive to the recomputation and the page alike.
    assert.deepEqual(
      ACTIVE_INCIDENT_STATUSES.filter(
        (status) => !INCIDENT_STATUSES.includes(status),
      ),
      [],
    );
  });

  it('leaves out the two statuses no customer has been told about', () => {
    // A draft was never shown, and a resolved incident is over. DOMAIN's
    // recomputation inputs and its public page rule both say so.
    const excluded = INCIDENT_STATUSES.filter(
      (status) => !ACTIVE_INCIDENT_STATUSES.includes(status as never),
    );
    assert.deepEqual(excluded, ['draft', 'resolved']);
  });
});
