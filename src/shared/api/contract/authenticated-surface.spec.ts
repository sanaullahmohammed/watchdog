import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Every REST route and GraphQL resolver resolves an authenticated organization
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
 * Needs no database; runs with the unit suite.
 */

// This project compiles to CommonJS, so __dirname rather than import.meta.
const MODULES_ROOT = join(__dirname, '../../../modules');

/**
 * Surfaces that are public by design, each with its reason. Empty today.
 * Epic 3's unauthenticated `/status/:orgSlug` payload is the expected first
 * entry, added in the story that builds it.
 */
const PUBLIC_BY_DESIGN: ReadonlyMap<string, string> = new Map();

const AUTH_CALL = 'resolveOrganizationContext(';

function surfaceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return surfaceFiles(path);
    return /\.(route|resolver)\.ts$/.test(entry.name) ? [path] : [];
  });
}

const files = surfaceFiles(MODULES_ROOT).map((path) => ({
  path,
  label: relative(MODULES_ROOT, path),
}));

describe('Authenticated API surface', () => {
  it('discovers the route and resolver files to check', () => {
    // Guards the guard: an empty walk would make the assertion below vacuous.
    assert.ok(files.length > 0, 'no route or resolver files found');
    assert.ok(files.some((f) => f.label.endsWith('.route.ts')));
    assert.ok(files.some((f) => f.label.endsWith('.resolver.ts')));
  });

  it('resolves an organization context in every route and resolver not public by design', () => {
    const unauthenticated = files
      .filter((f) => !PUBLIC_BY_DESIGN.has(f.label))
      .filter((f) => !readFileSync(f.path, 'utf8').includes(AUTH_CALL))
      .map((f) => f.label);

    assert.deepEqual(
      unauthenticated,
      [],
      'each of these reaches the command or query bus without resolving who is calling. ' +
        'Call resolveOrganizationContext and refuse when it returns null, or add the file ' +
        'to PUBLIC_BY_DESIGN with the reason it is public.',
    );
  });

  it('keeps the public allowlist honest', () => {
    const labels = new Set(files.map((f) => f.label));
    const stale = [...PUBLIC_BY_DESIGN.keys()].filter((l) => !labels.has(l));
    assert.deepEqual(stale, [], 'allowlisted files that no longer exist');
  });
});
