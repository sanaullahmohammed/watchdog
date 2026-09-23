import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type EnumTypeDefinitionNode, parse } from 'graphql';
import {
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  MAINTENANCE_STATUSES,
  SERVICE_STATUSES,
  UPTIME_DAY_STATUSES,
} from '@/shared/domain/status-inputs';
import statusLaddersSchema from '@/shared/domain/status-ladders.graphql-schema';

/**
 * The SDL ladders and the TypeScript ladders are the same ladders, declared
 * twice because neither language can read the other. Nothing but this spec
 * stops one of them gaining a value the other does not have, and a ladder that
 * differs across surfaces is a value REST accepts and GraphQL rejects, or the
 * reverse.
 */

const values = Object.fromEntries(
  parse(statusLaddersSchema)
    .definitions.filter(
      (definition): definition is EnumTypeDefinitionNode =>
        definition.kind === 'EnumTypeDefinition',
    )
    .map((definition) => [
      definition.name.value,
      definition.values?.map((value) => value.name.value) ?? [],
    ]),
);

describe('The status ladders, in SDL and in TypeScript', () => {
  it('declares every ladder the shared module defines, and no other', () => {
    // Guards the guard: a renamed or missing enum would leave a check below
    // comparing undefined with undefined.
    assert.deepEqual(Object.keys(values).sort(), [
      'IncidentImpact',
      'IncidentStatus',
      'MaintenanceStatus',
      'ServiceStatus',
      'UptimeDayStatus',
    ]);
  });

  it('agrees on the values of each', () => {
    assert.deepEqual(values.ServiceStatus, [...SERVICE_STATUSES]);
    assert.deepEqual(values.IncidentStatus, [...INCIDENT_STATUSES]);
    assert.deepEqual(values.IncidentImpact, [...INCIDENT_IMPACTS]);
    assert.deepEqual(values.MaintenanceStatus, [...MAINTENANCE_STATUSES]);
    assert.deepEqual(values.UptimeDayStatus, [...UPTIME_DAY_STATUSES]);
  });
});
