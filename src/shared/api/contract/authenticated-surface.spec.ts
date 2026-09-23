import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

/**
 * Every REST route and GraphQL field resolves an authenticated organization
 * context, unless it is listed below as deliberately public.
 *
 * Epic 2's retrospective (R-1) found the boilerplate's `delete-user` exposed on
 * both surfaces with no authentication. Its GraphQL resolver had been added to
 * satisfy the parity contract, which compares request shapes and never asks
 * who may call them. This is the check that would have refused it.
 *
 * It is structural rather than behavioural on purpose. A behavioural test
 * covers the endpoints someone remembered to test; this one covers every file
 * the route and resolver autoloaders will pick up, including the next one.
 *
 * The unit of both the check and the allowlist is one operation: a method and
 * path, or a GraphQL field. Keyed by file, as it was until Epic 3's
 * retrospective (R-16), the allowlist exempted everything in a public file, so
 * a mutation added beside `publicStatusPage` would have been unauthenticated
 * and unexamined, and a second route in any file was covered by its
 * neighbour's `resolveOrganizationContext` call. Each operation now has to
 * resolve a context inside its own body.
 *
 * Read with the TypeScript parser rather than by searching text, so a call in
 * a comment or in the file's other operation counts for neither.
 *
 * Needs no database; runs with the unit suite.
 */

// This project compiles to CommonJS, so __dirname rather than import.meta.
const MODULES_ROOT = join(__dirname, '../../../modules');

/** Operations that are public by design, each with its reason. */
const PUBLIC_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'GET /status/:orgSlug',
    'FR17: the status page is read by anyone holding the link, with no session. ' +
      'The organization comes from the slug through the pre-tenant path, and every ' +
      'read behind it is still tenant-scoped.',
  ],
  [
    'Query.publicStatusPage',
    'The same public page over GraphQL, public for the same reason.',
  ],
]);

const AUTH_CALL = 'resolveOrganizationContext';

/** The prefix `@fastify/autoload` gives a file's routes. */
const API_PREFIX = '/api';

type Operation = {
  /** `GET /api/v1/services`, or `Query.publicStatusPage`. */
  key: string;
  file: string;
  authenticated: boolean;
};

function surfaceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return surfaceFiles(path);
    return /\.(route|resolver)\.ts$/.test(entry.name) ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Every node under `root`, itself included. */
function* walk(root: ts.Node): Generator<ts.Node> {
  yield root;
  for (const child of root.getChildren()) {
    yield* walk(child);
  }
}

/** A call to `<something>.name(...)` or `name(...)`. */
function callsTo(node: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  for (const candidate of walk(node)) {
    if (!ts.isCallExpression(candidate)) continue;
    const callee = candidate.expression;
    const called = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    if (called === name) calls.push(candidate);
  }
  return calls;
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
      candidate.name.text === name,
  )?.initializer;
}

/** String literals in a property that holds one, or an array of them. */
function literals(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.filter(ts.isStringLiteral).map((e) => e.text);
  }
  return [];
}

/** The REST operations a route file declares, one per method it answers. */
function routeOperations(source: ts.SourceFile, label: string): Operation[] {
  // A public route serves the path the product names, with no /api prefix.
  const prefix = label.endsWith('.public.route.ts') ? '' : API_PREFIX;

  return callsTo(source, 'route').flatMap((call) => {
    const [argument] = call.arguments;
    if (!argument || !ts.isObjectLiteralExpression(argument)) return [];

    const methods = literals(property(argument, 'method'));
    const [url] = literals(property(argument, 'url'));
    if (methods.length === 0 || url === undefined) return [];

    const authenticated = callsTo(argument, AUTH_CALL).length > 0;
    return methods.map((method) => ({
      key: `${method.toUpperCase()} ${prefix}${url}`,
      file: label,
      authenticated,
    }));
  });
}

/** The GraphQL fields a resolver file defines, by the type they sit under. */
function resolverOperations(source: ts.SourceFile, label: string): Operation[] {
  const OPERATION_TYPES = ['Query', 'Mutation', 'Subscription'];

  return callsTo(source, 'defineResolvers').flatMap((call) => {
    const [argument] = call.arguments;
    if (!argument || !ts.isObjectLiteralExpression(argument)) return [];

    return argument.properties.flatMap((typeProperty) => {
      if (
        !ts.isPropertyAssignment(typeProperty) ||
        !ts.isIdentifier(typeProperty.name) ||
        !OPERATION_TYPES.includes(typeProperty.name.text) ||
        !ts.isObjectLiteralExpression(typeProperty.initializer)
      ) {
        return [];
      }

      const type = typeProperty.name.text;
      return typeProperty.initializer.properties.flatMap((field) => {
        const name = field.name;
        if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) {
          return [];
        }
        return [
          {
            key: `${type}.${name.text}`,
            file: label,
            // The field's own body, not the file's: a sibling field's check
            // says nothing about this one.
            authenticated: callsTo(field, AUTH_CALL).length > 0,
          },
        ];
      });
    });
  });
}

const files = surfaceFiles(MODULES_ROOT).map((path) => ({
  path,
  label: relative(MODULES_ROOT, path),
}));

const operations = files.flatMap(({ path, label }) => {
  const source = parse(path);
  return label.endsWith('.resolver.ts')
    ? resolverOperations(source, label)
    : routeOperations(source, label);
});

describe('Authenticated API surface', () => {
  it('discovers an operation in every route and resolver file', () => {
    // Guards the guard twice over: an empty walk would make the check below
    // vacuous, and a file whose shape the parser does not recognise would
    // drop out of it silently, which is how a surface goes unexamined.
    assert.ok(files.length > 0, 'no route or resolver files found');

    const silent = files
      .filter(({ label }) => !operations.some((o) => o.file === label))
      .map(({ label }) => label);
    assert.deepEqual(
      silent,
      [],
      'no operation was found in these, so nothing about them was checked. ' +
        'Either they declare no route or field, or they declare one in a shape ' +
        'this spec cannot read, and it has to learn that shape.',
    );

    assert.ok(
      operations.filter((o) => o.key.includes(' ')).length >= 15,
      'too few REST operations found; the route walk is wrong',
    );
    assert.ok(
      operations.filter((o) => !o.key.includes(' ')).length >= 15,
      'too few GraphQL fields found; the resolver walk is wrong',
    );
  });

  it('resolves an organization context in every operation not public by design', () => {
    const unauthenticated = operations
      .filter((operation) => !PUBLIC_BY_DESIGN.has(operation.key))
      .filter((operation) => !operation.authenticated)
      .map((operation) => `${operation.key} (${operation.file})`);

    assert.deepEqual(
      unauthenticated,
      [],
      'each of these reaches the command or query bus without resolving who is calling. ' +
        'Call resolveOrganizationContext in the operation itself and refuse when it ' +
        'returns null, or add the operation to PUBLIC_BY_DESIGN with the reason it is public.',
    );
  });

  it('keeps the public allowlist honest', () => {
    const keys = new Set(operations.map((operation) => operation.key));
    const stale = [...PUBLIC_BY_DESIGN.keys()].filter((key) => !keys.has(key));
    assert.deepEqual(stale, [], 'allowlisted operations that no longer exist');
  });
});
