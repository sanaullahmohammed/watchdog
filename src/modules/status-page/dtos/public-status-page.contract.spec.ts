import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ObjectTypeDefinitionNode, parse, type TypeNode } from 'graphql';
import { publicStatusPageResponseDtoSchema } from '@/modules/status-page/dtos/public-status-page.response.dto';
import publicStatusPageSchema from '@/modules/status-page/queries/get-public-status-page/get-public-status-page.graphql-schema';
import getGQL from '@/server/plugins/gql';
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

    // The enum itself lives with the other ladders, and
    // `status-ladders.spec.ts` holds its values to the TypeScript ones.
    assert.equal(
      fields.find((field) => field.name.value === 'worstStatus')?.type.kind ===
        'NamedType' &&
        (
          fields.find((field) => field.name.value === 'worstStatus')?.type as {
            name: { value: string };
          }
        ).name.value,
      'UptimeDayStatus',
    );
  });
});

/**
 * Epic 3 retrospective, action item 13 (R-10): the public contract is the
 * page's own, not the admin types it once borrowed.
 *
 * `PublicStatusIncident.updates` was `[IncidentUpdate!]!`, the incident
 * module's admin type, so a field added there for operators would have become
 * selectable anonymously. This walks the merged schema from the public query
 * and pins every type it can reach.
 */
describe('The types the public query can reach', () => {
  it('reaches its own types and the shared ladders, and nothing else', async () => {
    const document = parse(await getGQL());

    const byName = new Map(
      document.definitions.flatMap((definition) =>
        'name' in definition && definition.name
          ? [[definition.name.value, definition] as const]
          : [],
      ),
    );

    const named = (type: TypeNode): string =>
      type.kind === 'NamedType' ? type.name.value : named(type.type);

    const query = byName.get('Query');
    assert.ok(query && query.kind === 'ObjectTypeDefinition');
    const entry = query.fields?.find(
      (field) => field.name.value === 'publicStatusPage',
    );
    assert.ok(entry, 'the public query is in the schema');

    // GraphQL's own scalars are nobody's to own.
    const BUILT_IN = new Set(['String', 'ID', 'Int', 'Float', 'Boolean']);

    const reached = new Set<string>();
    const pending = [named(entry.type)];
    while (pending.length > 0) {
      const name = pending.pop() as string;
      if (reached.has(name) || BUILT_IN.has(name)) continue;
      reached.add(name);
      const definition = byName.get(name);
      if (definition?.kind !== 'ObjectTypeDefinition') continue;
      for (const field of definition.fields ?? []) {
        pending.push(named(field.type));
        for (const argument of field.arguments ?? []) {
          pending.push(named(argument.type));
        }
      }
    }

    // Exact, so borrowing an admin type, or adding a type to the public
    // surface, fails here until someone decides it belongs.
    assert.deepEqual([...reached].sort(), [
      'IncidentImpact',
      'IncidentStatus',
      'MaintenanceStatus',
      'PublicStatusGroup',
      'PublicStatusIncident',
      'PublicStatusIncidentUpdate',
      'PublicStatusMaintenance',
      'PublicStatusOrganization',
      'PublicStatusPage',
      'PublicStatusService',
      'PublicStatusUptime',
      'PublicStatusUptimeDay',
      'PublicStatusUptimeService',
      'ServiceStatus',
      'UptimeDayStatus',
    ]);
  });
});
