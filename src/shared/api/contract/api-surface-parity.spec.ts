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
 * surface must be exposed over both, unless it is named in
 * `REST_ONLY_BY_DESIGN` below. Fields: where a capability has both a
 * `.schema.ts` and a `.graphql-schema.ts`, their request field names must
 * agree, and a pair the check cannot compare fails rather than passing
 * unexamined. It once skipped such a pair silently, and the public status page
 * passed with nothing compared (Epic 3 retrospective, R-9).
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
 * The field names of the request an SDL fragment describes.
 *
 * When an argument names an input type declared in the same fragment, that type
 * is the payload, and its fields are the request. Picking the first type
 * declared was the original heuristic, and it produced a false positive the
 * moment a file declared a nested input type before its payload, as
 * create-incident does with AffectedServiceInput. Scalar arguments beside a
 * payload, such as `id: ID!`, are REST path parameters that no `.schema.ts`
 * describes, so they are left out.
 *
 * When no argument names a declared type, the scalar arguments are the whole
 * request, and REST carries them as path parameters, which the slice's
 * `.schema.ts` then describes: `publicStatusPage(orgSlug: ID!)` against
 * `{ orgSlug }`.
 *
 * Undefined when the fragment declares no operation with an argument.
 */
function sdlRequestFields(sdl: string): string[] | undefined {
  const document = parse(sdl);

  const declared = new Map<string, string[]>();
  const operations: string[] = [];
  const argumentNames: string[] = [];

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
          argumentNames.push(arg.name.value);
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

  return argumentNames.length > 0 ? argumentNames : undefined;
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

/**
 * Capabilities reachable over REST only, by design, each with its reason
 * (ARCHITECTURE 7.1). Keyed by slice label. The coverage check skips them, and
 * the stale-entry check holds each to a slice that exists, has a route and has
 * no resolver, so an exemption cannot outlive the reason it was granted.
 */
const REST_ONLY_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'status-page/queries/open-public-status-stream',
    'The public status stream is Server-Sent Events, which has no SDL form, and ' +
      'its GraphQL equivalent would be a subscription, which is admin-only (story 4.5).',
  ],
  [
    'notification/commands/create-subscriber',
    'Subscribe, confirm and unsubscribe are REST only in v1: the links in the ' +
      'emails land on REST endpoints and no admin lists subscribers (Epic 6, ' +
      'ARCHITECTURE 5.6; story 6.3).',
  ],
  [
    'notification/commands/confirm-subscriber',
    'The confirmation link in the email acts on GET and answers plain text, so ' +
      'it has no GraphQL form (Epic 6, ARCHITECTURE 5.6; story 6.4).',
  ],
  [
    'notification/commands/unsubscribe',
    'The unsubscribe link acts on GET and RFC 8058 one-click POST and answers ' +
      'plain text, so it has no GraphQL form (Epic 6, ARCHITECTURE 5.6; story 6.4).',
  ],
  [
    'notification/queries/get-atom-feed',
    'The Atom feed is an XML document a feed reader fetches by URL, so it has no ' +
      'SDL form (FR20, Epic 6, ARCHITECTURE 5.6; story 6.8).',
  ],
]);

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
      .filter((c) => !REST_ONLY_BY_DESIGN.has(c.label))
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

  it('keeps the REST-only exemptions honest', () => {
    const byLabel = new Map(capabilities.map((c) => [c.label, c]));
    const stale = [...REST_ONLY_BY_DESIGN.keys()].flatMap((label) => {
      const capability = byLabel.get(label);
      if (!capability) return [`${label}: no such slice`];
      if (!capability.routeFile) return [`${label}: it has no route`];
      if (capability.resolverFile) {
        return [`${label}: it has a resolver, ${capability.resolverFile}`];
      }
      return [];
    });

    assert.deepEqual(
      stale,
      [],
      'a REST-only exemption must name a slice reachable over REST and not over GraphQL',
    );
  });

  it('agrees on request field names wherever both surfaces describe one', async () => {
    const divergences: string[] = [];
    let compared = 0;

    for (const capability of capabilities) {
      if (!capability.schemaFile || !capability.graphqlFile) continue;

      const schemaModule = (await import(
        join(capability.dir, capability.schemaFile)
      )) as Record<string, unknown>;
      const graphqlModule = (await import(
        join(capability.dir, capability.graphqlFile)
      )) as { default: string };

      const restShapes = [...typeBoxFieldNames(schemaModule).entries()];
      const sdlRequest = sdlRequestFields(graphqlModule.default);

      // A `.schema.ts` describes one request. A second TypeBox object there is
      // ambiguous: the status page's once held only its response, which would
      // have been compared as the request had the SDL side produced anything.
      if (restShapes.length !== 1) {
        divergences.push(
          `${capability.label}: ${capability.schemaFile} exports ` +
            `${restShapes.length} TypeBox objects ` +
            `(${restShapes.map(([name]) => name).join(', ') || 'none'}); ` +
            'it must export exactly one, the request, for the contract to compare',
        );
        continue;
      }
      if (sdlRequest === undefined) {
        divergences.push(
          `${capability.label}: ${capability.graphqlFile} declares no operation ` +
            'argument, so there is nothing to compare the REST request with',
        );
        continue;
      }

      // Compare the request each surface accepts. Both are authored by hand,
      // so a field added to one and forgotten on the other is the exact drift
      // this test exists to catch.
      compared += 1;
      const rest = new Set(restShapes[0][1]);
      const sdl = new Set(sdlRequest);

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
    // Every path above either compares a pair or reports why it could not.
    // This holds the loop to that: a bare `continue` added later, which is how
    // a pair once passed unexamined, fails here.
    assert.equal(
      compared,
      capabilities.filter((c) => c.schemaFile && c.graphqlFile).length,
      'every capability with both files was compared',
    );
  });
});
