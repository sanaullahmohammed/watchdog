import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
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
});
