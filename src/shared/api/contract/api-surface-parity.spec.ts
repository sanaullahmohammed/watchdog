import assert from 'node:assert/strict';
import { type Dirent, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { parse, type TypeNode } from 'graphql';

/**
 * Story 2.1 — REST and GraphQL must not drift apart.
 *
 * The two surfaces have no shared source. REST validation is authored as
 * TypeBox in `*.schema.ts`; GraphQL is hand-written SDL in
 * `*.graphql-schema.ts`, discovered by `loadFiles` and merged. Generating one
 * from the other is a real project, and this story does not assume it:
 *
 *   DECISION: neither surface generates the other. They stay independently
 *   authored and this test is the contract between them. If generation is ever
 *   introduced it runs TypeBox -> SDL, because TypeBox already carries the
 *   validation constraints Swagger needs and SDL cannot express them.
 *
 * Two checks, in increasing strength. Coverage: a capability exposed over one
 * surface must be exposed over both. Fields: where both exist, their field
 * names must agree.
 *
 * Needs no database; runs with the unit suite so it fails in CI's cheap job.
 */

// This project compiles to CommonJS, so __dirname rather than import.meta.
const MODULES_ROOT = join(__dirname, '../../../modules');

type Capability = {
  dir: string;
  label: string;
  routeFile?: string;
  resolverFile?: string;
  schemaFile?: string;
  graphqlFile?: string;
};

/** A capability is one command or query directory: `<module>/<kind>/<name>/`. */
function discoverCapabilities(): Capability[] {
  const found: Capability[] = [];

  for (const mod of readdirSync(MODULES_ROOT, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;

    for (const kind of ['commands', 'queries']) {
      const kindDir = join(MODULES_ROOT, mod.name, kind);
      let entries: Dirent[];
      try {
        entries = readdirSync(kindDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(kindDir, entry.name);
        const files = readdirSync(dir);
        found.push({
          dir,
          label: `${mod.name}/${kind}/${entry.name}`,
          routeFile: files.find((f) => f.endsWith('.route.ts')),
          resolverFile: files.find((f) => f.endsWith('.resolver.ts')),
          schemaFile: files.find(
            (f) =>
              f.endsWith('.schema.ts') && !f.endsWith('.graphql-schema.ts'),
          ),
          graphqlFile: files.find((f) => f.endsWith('.graphql-schema.ts')),
        });
      }
    }
  }

  return found.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The field names of the request payload an SDL fragment describes.
 *
 * The payload is the input type named by the operation's argument, not simply
 * the first type declared. Picking by declaration order was the original
 * heuristic and it produced a false positive the moment a file declared a
 * nested input type before its payload, as create-incident does with
 * AffectedServiceInput.
 *
 * Scalar arguments such as `id: ID!` are skipped; only a type defined in the
 * same fragment can be the payload.
 */
function sdlPayloadFields(sdl: string): string[] | undefined {
  const document = parse(sdl);

  const declared = new Map<string, string[]>();
  const operations: string[] = [];

  const OPERATION_TYPES = ['Mutation', 'Query', 'Subscription'];

  for (const def of document.definitions) {
    // Operation types carry the arguments that name the payload.
    if (
      def.kind === 'ObjectTypeDefinition' &&
      OPERATION_TYPES.includes(def.name.value)
    ) {
      for (const field of def.fields ?? []) {
        for (const arg of field.arguments ?? []) {
          let type: TypeNode = arg.type;
          while (type.kind !== 'NamedType') type = type.type;
          operations.push(type.name.value);
        }
      }
      continue;
    }

    if (
      def.kind === 'ObjectTypeDefinition' ||
      def.kind === 'InputObjectTypeDefinition'
    ) {
      declared.set(
        def.name.value,
        (def.fields ?? []).map((field) => field.name.value),
      );
    }
  }

  for (const named of operations) {
    const fields = declared.get(named);
    if (fields) return fields;
  }

  return undefined;
}

/** Property names of every TypeBox object exported by a schema module. */
function typeBoxFieldNames(
  module: Record<string, unknown>,
): Map<string, string[]> {
  const byExport = new Map<string, string[]>();

  for (const [name, value] of Object.entries(module)) {
    const properties = (value as { properties?: Record<string, unknown> })
      ?.properties;
    if (properties && typeof properties === 'object') {
      byExport.set(name, Object.keys(properties));
    }
  }

  return byExport;
}

const capabilities = discoverCapabilities();

describe('REST and GraphQL surface parity', () => {
  it('discovers the capabilities to compare', () => {
    // Guards the guard: an empty list would make every assertion below vacuous.
    assert.ok(
      capabilities.length > 0,
      'no command or query directories found; the discovery walk is wrong',
    );
  });

  it('exposes every capability over both surfaces', () => {
    const gaps = capabilities
      .filter((c) => Boolean(c.routeFile) !== Boolean(c.resolverFile))
      .map((c) => ({
        capability: c.label,
        rest: c.routeFile ?? 'MISSING',
        graphql: c.resolverFile ?? 'MISSING',
        at: relative(process.cwd(), c.dir),
      }));

    assert.deepEqual(
      gaps,
      [],
      'a capability reachable over one surface must be reachable over both',
    );
  });

  it('agrees on field names where both surfaces describe a payload', async () => {
    const divergences: string[] = [];

    for (const capability of capabilities) {
      if (!capability.schemaFile || !capability.graphqlFile) continue;

      const schemaModule = (await import(
        join(capability.dir, capability.schemaFile)
      )) as Record<string, unknown>;
      const graphqlModule = (await import(
        join(capability.dir, capability.graphqlFile)
      )) as { default: string };

      const restShapes = [...typeBoxFieldNames(schemaModule).values()];
      const sdlPayload = sdlPayloadFields(graphqlModule.default);

      if (restShapes.length === 0 || sdlPayload === undefined) continue;

      // Compare the request payload each surface accepts. Both are authored by
      // hand, so a field added to one and forgotten on the other is the exact
      // drift this test exists to catch.
      const rest = new Set(restShapes[0]);
      const sdl = new Set(sdlPayload);

      const onlyRest = [...rest].filter((f) => !sdl.has(f));
      const onlySdl = [...sdl].filter((f) => !rest.has(f));

      if (onlyRest.length > 0 || onlySdl.length > 0) {
        divergences.push(
          [
            `${capability.label}:`,
            onlyRest.length > 0
              ? `  only in REST (${capability.schemaFile}): ${onlyRest.join(', ')}`
              : '',
            onlySdl.length > 0
              ? `  only in GraphQL (${capability.graphqlFile}): ${onlySdl.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
    }

    assert.deepEqual(divergences, []);
  });
});
