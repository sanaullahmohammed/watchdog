import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import maintenanceDomain from '@/modules/maintenance/domain/maintenance.domain';
import {
  CompletedMaintenanceImmutableError,
  MaintenanceNotDeletableError,
  RunningMaintenanceFieldsError,
} from '@/modules/maintenance/domain/maintenance.errors';
import {
  MAINTENANCE_STATUSES,
  type MaintenanceStatus,
} from '@/modules/maintenance/domain/maintenance.types';

/**
 * Epic 2 retrospective, R-8: what may be edited or deleted, and when.
 *
 * Swept across the whole ladder rather than spot-checked, so a new status has
 * to state its answer here instead of inheriting one by accident.
 */

const domain = maintenanceDomain();
const editable: MaintenanceStatus[] = ['scheduled', 'in_progress'];

describe('maintenanceDomain.assertDeletable', () => {
  it('allows only a scheduled window to be deleted', () => {
    for (const status of MAINTENANCE_STATUSES) {
      if (status === 'scheduled') {
        assert.doesNotThrow(() => domain.assertDeletable(status));
      } else {
        assert.throws(
          () => domain.assertDeletable(status),
          MaintenanceNotDeletableError,
          `${status} must not be deletable`,
        );
      }
    }
  });

  it('names the status it refused, and points at completing instead', () => {
    assert.throws(() => domain.assertDeletable('in_progress'), {
      message: /in_progress.*complete it instead/is,
    });
  });
});

describe('maintenanceDomain.assertEditable', () => {
  it('refuses every edit to a completed window', () => {
    for (const edit of [
      { title: 'new' },
      { scheduledEndAt: new Date() },
      { affectedServiceIds: [] },
      {},
    ]) {
      assert.throws(
        () => domain.assertEditable('completed', edit),
        CompletedMaintenanceImmutableError,
      );
    }
  });

  it('lets a scheduled window change anything', () => {
    assert.doesNotThrow(() =>
      domain.assertEditable('scheduled', {
        title: 'new',
        description: null,
        scheduledStartAt: new Date(),
        scheduledEndAt: new Date(),
        affectedServiceIds: ['a'],
      }),
    );
  });

  it('lets a running window be extended and have its services corrected', () => {
    assert.doesNotThrow(() =>
      domain.assertEditable('in_progress', {
        scheduledEndAt: new Date(),
        affectedServiceIds: ['a'],
      }),
    );
  });

  it('refuses what describes a window that has already begun', () => {
    for (const edit of [
      { title: 'new' },
      { description: 'new' },
      { scheduledStartAt: new Date() },
    ]) {
      assert.throws(
        () => domain.assertEditable('in_progress', edit),
        RunningMaintenanceFieldsError,
      );
    }
  });

  it('names every locked field the edit touched', () => {
    assert.throws(
      () =>
        domain.assertEditable('in_progress', {
          title: 'new',
          scheduledStartAt: new Date(),
          scheduledEndAt: new Date(),
        }),
      { message: /title.*scheduledStartAt/s },
    );
  });

  it('accepts an empty edit wherever editing is allowed at all', () => {
    for (const status of editable) {
      assert.doesNotThrow(() => domain.assertEditable(status, {}));
    }
  });
});
