import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Source reading shared by the structural specs (the foreign-table allowlist
 * and the public-rule copy guard). It lives outside any spec because
 * importing a spec file registers its tests a second time.
 */

/** Stands in for an interpolation inside a scanned `sql` template. */
export const PLACEHOLDER = '\uE000';

/** Every non-test `.ts` file under `dir`, recursively. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isTest = /\.(spec|test)\.ts$|\.integration\.test\.ts$/.test(
      entry.name,
    );
    return entry.name.endsWith('.ts') && !isTest ? [path] : [];
  });
}

/** `source` parsed with the TypeScript compiler. */
export function parseSource(source: string, name = 'scan.ts'): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}

/**
 * The literal text of every template tagged `sql` or `<expr>.sql` in a
 * source, fragments included, with interpolations blanked to PLACEHOLDER.
 * Never an untagged template.
 */
export function sqlTemplates(source: string): string[] {
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
  visit(parseSource(source));
  return found;
}
