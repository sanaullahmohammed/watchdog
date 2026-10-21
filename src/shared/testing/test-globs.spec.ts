import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The test scripts hand their globs to Node quoted, so Node expands them.
 *
 * Unquoted, `sh` expands them first, and `sh` has no globstar: `**` matches a
 * single directory. `src/**\/*.integration.test.ts` reached Node intact only
 * while no file sat one directory below `src/`. The first that did, a suite
 * in `src/server/`, became the whole expansion, and the integration run
 * shrank to its 5 tests while reporting success. Node expands a quoted
 * pattern itself, recursively.
 */

// This project compiles to CommonJS, so __dirname rather than import.meta.
const ROOT = join(__dirname, '../../..');
const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
).scripts;

describe('test script globs', () => {
  it('finds the scripts that run node --test', () => {
    // Guards the guard: an empty list would make the check below vacuous.
    assert.ok(
      Object.values(scripts).filter((s) => s.includes('--test')).length >= 2,
    );
  });

  it('quotes every glob it hands to node --test', () => {
    const unquoted = Object.entries(scripts)
      .filter(([, script]) => script.includes('--test'))
      .flatMap(([name, script]) =>
        script
          .split(/\s+/)
          .filter((token) => token.includes('*'))
          .filter((token) => !/^(['"]).*\1$/.test(token))
          .map((token) => `${name}: ${token}`),
      );

    assert.deepEqual(
      unquoted,
      [],
      'quote these, or sh expands them one directory deep before Node sees them',
    );
  });

  // A glob that matches nothing still exits 0, so a script whose files moved
  // or were misnamed would report success with no test run at all.
  it('matches at least one file with every quoted glob', () => {
    const quoted = Object.entries(scripts)
      .filter(([, script]) => script.includes('--test'))
      .flatMap(([name, script]) =>
        script
          .split(/\s+/)
          .filter((token) => /^(['"]).*\*.*\1$/.test(token))
          .map((token) => ({ name, glob: token.slice(1, -1) })),
      );
    assert.ok(quoted.length >= 2, 'no quoted --test globs found');

    const empty = quoted
      .filter(({ glob }) => globSync(glob, { cwd: ROOT }).length === 0)
      .map(({ name, glob }) => `${name}: ${glob}`);
    assert.deepEqual(empty, [], 'these globs match no file');
  });
});
