import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

/**
 * A module reads only its own tables, plus the foreign ones listed here.
 *
 * Modules never import each other, but SQL reaches across a boundary without
 * an import, so a join on another module's table is the one coupling that
 * `dependency-cruiser` cannot see. Each such read is a decision, recorded
 * below with its reason. Epic 3 retrospective, item 23.
 *
 * Read with the TypeScript parser: the text of every template tagged `sql` or
 * `<expr>.sql`, fragments included, and never an untagged template. Needs no
 * database; runs with the unit suite.
 */

// This project compiles to CommonJS, so __dirname rather than import.meta.
const MODULES_ROOT = join(__dirname, '../../modules');
const AUTH_SCHEMA = join(__dirname, '../../../db/better-auth-schema.sql');

const authTables = [
  ...readFileSync(AUTH_SCHEMA, 'utf8').matchAll(/create table "([^"]+)"/g),
].map((match) => match[1]);

/** Module -> the tables it owns. `better-auth` is not a module: its group. */
const OWNED: Readonly<Record<string, readonly string[]>> = {
  incident: ['incidents', 'incident_updates', 'incident_service_impacts'],
  maintenance: ['maintenance', 'maintenance_services'],
  monitoring: ['monitors', 'check_results', 'monitor_ssl_warnings'],
  service: ['services', 'service_groups'],
  'status-page': [],
  'better-auth': authTables,
};

/** Module -> the foreign tables it may read, each decided on purpose. */
const FOREIGN: Readonly<Record<string, readonly string[]>> = {
  incident: [],
  maintenance: [],
  // The due query skips archived services (Story 5.8).
  monitoring: ['services'],
  // The status computation reads what bears on a service's status.
  service: [
    'incidents',
    'incident_service_impacts',
    'maintenance',
    'maintenance_services',
  ],
  // The public page is assembled from every other module's tables, and
  // resolves the organization by slug.
  'status-page': [
    'services',
    'service_groups',
    'incidents',
    'incident_service_impacts',
    'incident_updates',
    'maintenance',
    'maintenance_services',
    'organization',
  ],
};

const KEYWORDS = new Set([
  'set',
  'select',
  'only',
  'lateral',
  'values',
  'where',
  'order',
  'limit',
  'of',
  'skip',
  'nowait',
  'locked',
  'and',
  'or',
  'not',
  'on',
  'conflict',
  'as',
  'using',
  'returning',
  'for',
  'key',
  'share',
  'no',
  'distinct',
  'default',
]);

const PLACEHOLDER = '\uE000';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isTest = /\.(spec|test)\.ts$|\.integration\.test\.ts$/.test(
      entry.name,
    );
    return entry.name.endsWith('.ts') && !isTest ? [path] : [];
  });
}

/** The literal text of every `sql` template in a source, interpolations blanked. */
export function sqlTemplates(source: string): string[] {
  const file = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      const isSql =
        (ts.isIdentifier(tag) && tag.text === 'sql') ||
        (ts.isPropertyAccessExpression(tag) && tag.name.text === 'sql');
      if (isSql) {
        const { template } = node;
        found.push(
          ts.isNoSubstitutionTemplateLiteral(template)
            ? template.text
            : template.head.text +
                template.templateSpans
                  .map((span) => PLACEHOLDER + span.literal.text)
                  .join(''),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Table names a piece of SQL reads or writes. */
export function tablesIn(text: string): string[] {
  const clean = text.replace(/--[^\n]*/g, ' ').toLowerCase();
  const tables: string[] = [];
  const pattern =
    /\b(?:from|join|into|update)\s+("[^"]+"(?:\."[^"]+")?|[a-z_][\w]*(?:\.[a-z_][\w]*)?|\(|\uE000)/g;
  for (const match of clean.matchAll(pattern)) {
    const name = match[1];
    if (name === '(' || name === PLACEHOLDER || KEYWORDS.has(name)) continue;
    tables.push(name.replace(/"/g, '').replace(/^public\./, ''));
  }
  return tables;
}

export type Read = { module: string; table: string; file: string };

export function readsIn(source: string, module: string, file: string): Read[] {
  return sqlTemplates(source).flatMap((text) =>
    tablesIn(text).map((table) => ({ module, table, file })),
  );
}

/** The reads that neither belong to the module nor are allowlisted. */
export function violations(reads: readonly Read[]): string[] {
  const known = new Set(Object.values(OWNED).flat());
  return reads.flatMap(({ module, table, file }) => {
    const own = OWNED[module] ?? [];
    const allowed = FOREIGN[module] ?? [];
    if (own.includes(table) || allowed.includes(table)) return [];
    return [
      known.has(table)
        ? `module ${module} reads foreign table ${table} in ${file}; allowlist it deliberately or stop`
        : `module ${module} reads table ${table} in ${file}, which no module owns; add it to a map`,
    ];
  });
}

function allReads(): Read[] {
  return sourceFiles(MODULES_ROOT).flatMap((path) => {
    const rel = relative(MODULES_ROOT, path);
    return readsIn(readFileSync(path, 'utf8'), rel.split(sep)[0], rel);
  });
}

describe('foreign table reads', () => {
  it('keeps every module to its own tables and its allowlist', () => {
    const reads = allReads();
    assert.ok(sourceFiles(MODULES_ROOT).length > 0, 'found no source files');
    assert.ok(reads.length > 0, 'found no table reads');
    assert.deepEqual(violations(reads), []);
  });

  it('lists no foreign table that its module no longer reads', () => {
    const reads = allReads();
    const stale = Object.entries(FOREIGN).flatMap(([module, tables]) =>
      tables
        .filter(
          (table) =>
            !reads.some((r) => r.module === module && r.table === table),
        )
        .map(
          (table) => `module ${module} allowlists ${table} but never reads it`,
        ),
    );
    assert.deepEqual(stale, []);
  });

  it('fails on an unlisted foreign read, naming module, table and file', () => {
    const reads = readsIn(
      'const rows = await tx.sql`select * from incidents i join services s on s.id = i.x`;',
      'monitoring',
      'monitoring/database/synthetic.ts',
    );
    assert.deepEqual(violations(reads), [
      'module monitoring reads foreign table incidents in monitoring/database/synthetic.ts; allowlist it deliberately or stop',
    ]);
  });

  it('fails on a table that no map lists', () => {
    const reads = readsIn(
      'await sql`insert into mystery_table (a) values (1)`;',
      'service',
      'service/x.ts',
    );
    assert.match(violations(reads)[0], /service reads table mystery_table/);
  });

  it('ignores comments, untagged templates and interpolation after from', () => {
    const source = [
      'const a = `select * from incidents`;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under scan
      'const b = sql`select 1 -- from incidents\n from services where x is distinct from ${y} for no key update`;',
    ].join('\n');
    assert.deepEqual(
      readsIn(source, 'service', 'f.ts').map((r) => r.table),
      ['services'],
    );
  });

  it('unquotes identifiers and drops public.', () => {
    assert.deepEqual(
      tablesIn('select 1 from "organization" o join public.monitors m on 1=1'),
      ['organization', 'monitors'],
    );
  });
});
