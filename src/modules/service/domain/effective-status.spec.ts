import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ResolveServiceStatusInput,
  resolveServiceStatus,
  SERVICE_STATUS_RANK,
} from '@/modules/service/domain/effective-status';
import {
  SERVICE_STATUSES,
  type ServiceStatus,
} from '@/modules/service/domain/service.types';
import {
  INCIDENT_IMPACTS,
  type IncidentImpact,
  MONITOR_DERIVED_STATES,
  type MonitorDerivedState,
} from '@/shared/domain/status-inputs';

/**
 * Story 2.16. FR5's verification line names the four inputs; DOMAIN.md names
 * the rule that combines them. Both are needed - a story derived from the line
 * alone once described a cascade.
 */

const base: ResolveServiceStatusInput = {
  manualOverride: null,
  activeIncidentImpacts: [],
  hasActiveMaintenance: false,
  monitorState: null,
};

const resolve = (overrides: Partial<ResolveServiceStatusInput>) =>
  resolveServiceStatus({ ...base, ...overrides });

describe('resolveServiceStatus', () => {
  it('returns a manual override unchanged, whatever the other inputs say', () => {
    // Including an override that is *better* than reality: an operator may pin
    // `operational` during a critical incident, and DOMAIN says the pin wins.
    assert.equal(
      resolve({
        manualOverride: 'operational',
        activeIncidentImpacts: ['critical'],
        hasActiveMaintenance: true,
        monitorState: 'failing',
      }),
      'operational',
    );
  });

  it('is a worst-of reduction, not a cascade', () => {
    // The distinguishing case. An active incident of impact `none` exists. A
    // cascade would take the incident branch and answer `operational`; the
    // reduction still considers maintenance and answers `maintenance`.
    assert.equal(
      resolve({ activeIncidentImpacts: ['none'], hasActiveMaintenance: true }),
      'maintenance',
    );
  });

  it('reduces several incidents to the worst among them', () => {
    assert.equal(
      resolve({ activeIncidentImpacts: ['minor', 'critical', 'major'] }),
      'major_outage',
    );
    // Order must not matter: the worst is not "the first" or "the last".
    assert.equal(
      resolve({ activeIncidentImpacts: ['critical', 'minor'] }),
      resolve({ activeIncidentImpacts: ['minor', 'critical'] }),
    );
  });

  it('lets an incident outrank maintenance at DOMAIN s mapped severity', () => {
    // major maps to partial_outage (3), critical to major_outage (4); both
    // outrank maintenance (1). The story originally claimed major gave
    // major_outage, which contradicts DOMAIN's own mapping.
    assert.equal(
      resolve({ activeIncidentImpacts: ['major'], hasActiveMaintenance: true }),
      'partial_outage',
    );
    assert.equal(
      resolve({
        activeIncidentImpacts: ['critical'],
        hasActiveMaintenance: true,
      }),
      'major_outage',
    );
    // And maintenance still outranks an incident too minor to matter.
    assert.equal(
      resolve({ activeIncidentImpacts: ['none'], hasActiveMaintenance: true }),
      'maintenance',
    );
  });

  it('resolves to operational when nothing contributes', () => {
    assert.equal(resolve({}), 'operational');
  });

  it('holds the reduction across every combination of inputs', () => {
    // Exhaustive: 6 override states x 16 incident subsets x 2 maintenance x 4
    // monitor states. The oracle is formulated differently from the
    // implementation - max over ranks rather than a pairwise reduce - so a
    // shared mistake is less likely to pass in both.
    const incidentSubsets: IncidentImpact[][] = [];
    for (let mask = 0; mask < 1 << INCIDENT_IMPACTS.length; mask += 1) {
      incidentSubsets.push(INCIDENT_IMPACTS.filter((_, i) => mask & (1 << i)));
    }

    const byRank = Object.fromEntries(
      Object.entries(SERVICE_STATUS_RANK).map(([s, r]) => [r, s]),
    ) as Record<number, ServiceStatus>;
    const impactRank = { none: 0, minor: 2, major: 3, critical: 4 } as const;
    const monitorRank = { healthy: 0, degraded: 2, failing: 4 } as const;

    let checked = 0;
    for (const manualOverride of [null, ...SERVICE_STATUSES]) {
      for (const activeIncidentImpacts of incidentSubsets) {
        for (const hasActiveMaintenance of [false, true]) {
          for (const monitorState of [
            null,
            ...MONITOR_DERIVED_STATES,
          ] as (MonitorDerivedState | null)[]) {
            const input = {
              manualOverride,
              activeIncidentImpacts,
              hasActiveMaintenance,
              monitorState,
            };
            const expected =
              manualOverride ??
              byRank[
                Math.max(
                  0,
                  ...activeIncidentImpacts.map((i) => impactRank[i]),
                  hasActiveMaintenance ? SERVICE_STATUS_RANK.maintenance : 0,
                  monitorState ? monitorRank[monitorState] : 0,
                )
              ];
            assert.equal(
              resolveServiceStatus(input),
              expected,
              JSON.stringify(input),
            );
            checked += 1;
          }
        }
      }
    }

    assert.equal(
      checked,
      6 * 16 * 2 * 4,
      'the sweep must cover every combination',
    );
  });
});
