import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AffectedService,
  overallStatus,
  publishable,
} from '@/modules/status-page/domain/public-page';

/**
 * Epic 3 retrospective, action item 1 (R-1, R-2, R-12). The rules are DOMAIN's,
 * section "Public status page".
 *
 * Fixtures run against the grain: the hidden service sits before the visible
 * one, so a rule that took the first id, or stopped at the first hidden one,
 * would fail here rather than pass by arrangement.
 */

const visible = (serviceId: string): AffectedService => ({
  serviceId,
  visible: true,
});
const hidden = (serviceId: string): AffectedService => ({
  serviceId,
  visible: false,
});

describe('publishable', () => {
  it('publishes only the visible ids of an item naming both kinds', () => {
    assert.deepEqual(
      publishable([
        {
          id: 'mixed',
          affectedServices: [
            hidden('h1'),
            visible('v1'),
            hidden('h2'),
            visible('v2'),
          ],
        },
      ]),
      [{ id: 'mixed', affectedServiceIds: ['v1', 'v2'] }],
    );
  });

  it('leaves off an item naming only services that are not visible', () => {
    assert.deepEqual(
      publishable([
        { id: 'private', affectedServices: [hidden('h1'), hidden('h2')] },
      ]),
      [],
    );
  });

  it('lists an item naming no service, since blast radius is often unknown', () => {
    assert.deepEqual(publishable([{ id: 'unnamed', affectedServices: [] }]), [
      { id: 'unnamed', affectedServiceIds: [] },
    ]);
  });

  it('keeps the order it was given and every other field', () => {
    // The repository has already ordered these; the rule must not reorder.
    // The one left off sits between two that stay.
    assert.deepEqual(
      publishable([
        { id: 'c', title: 'third', affectedServices: [visible('v')] },
        { id: 'b', title: 'gone', affectedServices: [hidden('h')] },
        { id: 'a', title: 'first', affectedServices: [] },
      ]),
      [
        { id: 'c', title: 'third', affectedServiceIds: ['v'] },
        { id: 'a', title: 'first', affectedServiceIds: [] },
      ],
    );
  });
});

describe('overallStatus', () => {
  it('lets a listed incident raise the banner above every service', () => {
    // Services all operational: only the incident can put the banner where it
    // is. `critical` maps to major_outage by DOMAIN's mapping.
    assert.equal(
      overallStatus([{ status: 'operational' }], [{ impact: 'critical' }]),
      'major_outage',
    );
    assert.equal(
      overallStatus([{ status: 'operational' }], [{ impact: 'major' }]),
      'partial_outage',
      'major is a partial outage, not a major one',
    );
  });

  it('lets a service outrank a milder incident', () => {
    assert.equal(
      overallStatus([{ status: 'partial_outage' }], [{ impact: 'minor' }]),
      'partial_outage',
    );
  });

  it('reduces every incident, not the first', () => {
    // The worst is last, so taking the first would answer degraded.
    assert.equal(
      overallStatus(
        [],
        [{ impact: 'minor' }, { impact: 'none' }, { impact: 'critical' }],
      ),
      'major_outage',
    );
  });

  it('is operational with nothing to report, and an impact-none incident changes nothing', () => {
    assert.equal(overallStatus([], []), 'operational');
    assert.equal(
      overallStatus([{ status: 'maintenance' }], [{ impact: 'none' }]),
      'maintenance',
    );
  });
});
