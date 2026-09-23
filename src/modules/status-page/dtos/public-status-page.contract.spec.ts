import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type EnumTypeDefinitionNode,
  type ObjectTypeDefinitionNode,
  parse,
} from 'graphql';
import { publicStatusPageResponseDtoSchema } from '@/modules/status-page/dtos/public-status-page.response.dto';
import publicStatusPageSchema from '@/modules/status-page/queries/get-public-status-page/get-public-status-page.graphql-schema';
import { UPTIME_DAY_STATUSES } from '@/shared/domain/status-inputs';

/**
 * Epic 3 retrospective, action item 12 (R-17): the uptime day's shape, on both
 * surfaces at once.
 *
 * Epic 5 fills `uptime.services`, so until then no request carries a day and
 * neither the parity contract, which compares request shapes, nor the
 * REST-against-GraphQL value test, which sees an empty array, would notice a
 * field added to one surface and not the other. This reads both declarations.
 */

type JsonSchema = {
  type?: string;
  enum?: string[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

const day = (publicStatusPageResponseDtoSchema as unknown as JsonSchema)
  .properties?.uptime.properties?.services.items?.properties?.days.items;

/** The branches of a nullable field, or the field itself when it is not one. */
const branches = (field: JsonSchema | undefined) => field?.anyOf ?? [field];

const admitsNull = (field: JsonSchema | undefined) =>
  branches(field).some((branch) => branch?.type === 'null');

const document = parse(publicStatusPageSchema);

const sdlType = (name: string) =>
  document.definitions.find(
    (definition): definition is ObjectTypeDefinitionNode =>
      definition.kind === 'ObjectTypeDefinition' &&
      definition.name.value === name,
  );

const sdlEnum = (name: string) =>
  document.definitions.find(
    (definition): definition is EnumTypeDefinitionNode =>
      definition.kind === 'EnumTypeDefinition' &&
      definition.name.value === name,
  );

describe("The uptime day's contract", () => {
  it('carries a date, a ratio and a worst status over REST', () => {
    assert.ok(day, 'the response schema declares a day');
    assert.deepEqual(Object.keys(day.properties ?? {}), [
      'date',
      'uptimeRatio',
      'worstStatus',
    ]);
  });

  it('lets a day with no checks say so, in both of its values', () => {
    // A day the rollups have no row for is a gap, not an outage, and the page
    // says so rather than omitting the day (DOMAIN, "Public status page").
    assert.equal(admitsNull(day?.properties?.uptimeRatio), true);
    assert.equal(admitsNull(day?.properties?.worstStatus), true);
    assert.equal(admitsNull(day?.properties?.date), false);
  });

  it("uses the rollups' three-level scale, not the service ladder", () => {
    const values = branches(day?.properties?.worstStatus).flatMap(
      (branch) => branch?.enum ?? [],
    );
    assert.deepEqual(values, [...UPTIME_DAY_STATUSES]);
  });

  it('declares the same day over GraphQL, with the same nullability', () => {
    const fields = sdlType('PublicStatusUptimeDay')?.fields ?? [];
    assert.deepEqual(
      fields.map((field) => [
        field.name.value,
        field.type.kind === 'NonNullType' ? 'required' : 'nullable',
      ]),
      [
        ['date', 'required'],
        ['uptimeRatio', 'nullable'],
        ['worstStatus', 'nullable'],
      ],
    );

    assert.deepEqual(
      sdlEnum('UptimeDayStatus')?.values?.map((value) => value.name.value),
      [...UPTIME_DAY_STATUSES],
    );
  });
});
