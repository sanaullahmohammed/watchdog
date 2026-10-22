import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import {
  parseSource,
  sourceFiles,
  sqlTemplates,
} from '@/shared/testing/source-scan';

/**
 * ARCHITECTURE 5.6: the public page, the feed and the notification pass apply
 * one rule for what is public, and none keeps a copy. Story 6.5 moved the rule
 * into `src/shared`; this keeps a copy from coming back (story 6.6).
 *
 * - A definition named `publishable` or `overallStatus` under `src/modules`
 *   fails: a function or method declaration, or a variable or property whose
 *   initializer is a function.
 * - `is_public` in a `sql` template of any module but `service`, which owns
 *   the column, fails: the visible-service predicate is `visibleService` in
 *   `src/shared/db/public-page-sql.ts`.
 *
 * A renamed copy gets past this, and that is accepted: the guard catches the
 * copy made by moving or pasting the code, not one written to evade it.
 *
 * Read with the TypeScript parser. Needs no database; runs with the unit suite.
 */

// This project compiles to CommonJS, so __dirname rather than import.meta.
const MODULES_ROOT = join(__dirname, '../../modules');

const RULE_NAMES = new Set(['publishable', 'overallStatus']);

/** The module that owns `services.is_public`. */
const OWNER_OF_IS_PUBLIC = 'service';

const isFunction = (node: ts.Node | undefined) =>
  node !== undefined &&
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

const nameOf = (name: ts.Node | undefined) =>
  name !== undefined &&
  (ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isPrivateIdentifier(name))
    ? name.text
    : undefined;

/** The rule names a source defines, one entry per definition. */
function ruleDefinitionsIn(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let name: string | undefined;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      name = nameOf(node.name);
    } else if (
      (ts.isVariableDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node)) &&
      isFunction(node.initializer)
    ) {
      name = nameOf(node.name);
    }
    if (name !== undefined && RULE_NAMES.has(name)) found.push(name);
    ts.forEachChild(node, visit);
  };
  visit(parseSource(source));
  return found;
}

/** Whether any `sql` template in the source names `is_public`. */
function readsIsPublic(source: string): boolean {
  return sqlTemplates(source).some((text) => /\bis_public\b/i.test(text));
}

const FILES = sourceFiles(MODULES_ROOT).map((path) => {
  const rel = relative(MODULES_ROOT, path);
  return {
    rel,
    module: rel.split(sep)[0],
    text: readFileSync(path, 'utf8'),
  };
});

describe('one rule for what is public: no copies', () => {
  it('reads the module sources', () => {
    assert.ok(FILES.length > 0, 'found no source files');
    // Not vacuous: the owner's own SQL names the column, so the scan sees it.
    assert.ok(
      FILES.some(
        ({ module, text }) =>
          module === OWNER_OF_IS_PUBLIC && readsIsPublic(text),
      ),
      'the service module names is_public in SQL',
    );
  });

  it('finds no definition of publishable or overallStatus under src/modules', () => {
    const copies = FILES.flatMap(({ rel, text }) =>
      ruleDefinitionsIn(text).map(
        (name) =>
          `${rel} defines ${name}; import it from @/shared/domain/public-page`,
      ),
    );
    assert.deepEqual(copies, []);
  });

  it('finds is_public in no sql template outside the service module', () => {
    const copies = FILES.filter(
      ({ module, text }) =>
        module !== OWNER_OF_IS_PUBLIC && readsIsPublic(text),
    ).map(
      ({ rel }) =>
        `${rel} names is_public in SQL; use visibleService from @/shared/db/public-page-sql`,
    );
    assert.deepEqual(copies, []);
  });

  it('catches every shape of definition it claims to', () => {
    const shapes = [
      'export function publishable() {}',
      'function overallStatus() {}',
      'const publishable = () => [];',
      'let overallStatus = function () {};',
      'const rules = { publishable: () => [] };',
      "const rules = { 'overallStatus': function () {} };",
      'const rules = { publishable() { return []; } };',
      'class Rules { overallStatus() {} }',
      'class Rules { publishable = () => []; }',
      'export default function repo() { return { overallStatus() {} }; }',
    ];
    for (const shape of shapes) {
      assert.equal(ruleDefinitionsIn(shape).length, 1, shape);
    }
  });

  it('lets an import, a call or a re-export of the shared rule through', () => {
    const uses = [
      "import { publishable, overallStatus } from '@/shared/domain/public-page';",
      'const listed = publishable(items);',
      'const banner = overallStatus(services, listed);',
      'const rules = { publishable };',
      'const result = { publishable: publishable(items) };',
      "export { publishable } from '@/shared/domain/public-page';",
    ];
    for (const use of uses) {
      assert.deepEqual(ruleDefinitionsIn(use), [], use);
    }
  });

  it('catches is_public in a sql template, and only there', () => {
    assert.equal(
      readsIsPublic('await tx.sql`select 1 from services where is_public`;'),
      true,
    );
    assert.equal(
      readsIsPublic('await sql`select (s.IS_PUBLIC and true) as v`;'),
      true,
    );
    assert.equal(readsIsPublic('const note = `is_public`;'), false);
    assert.equal(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under scan
      readsIsPublic('// is_public\nawait tx.sql`select ${visible}`;'),
      false,
    );
  });
});
