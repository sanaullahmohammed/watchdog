import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { before, describe, it } from 'node:test';
import {
  buildSchema,
  type GraphQLSchema,
  parse,
  type SelectionSetNode,
  specifiedRules,
  validate,
} from 'graphql';
import {
  createOnePublicPagePerOperation,
  onePublicPagePerOperation,
} from '@/server/graphql-public-page-limit';
import getGQL from '@/server/plugins/gql';

/**
 * Epic 3 retrospective, action item 16 (R-5): one page per operation, against
 * the real schema, with only this rule applied.
 */

let schema: GraphQLSchema;
const errors = (query: string) =>
  validate(schema, parse(query), [onePublicPagePerOperation]).map(
    (error) => error.message,
  );

const page = (alias = '') =>
  `${alias ? `${alias}: ` : ''}publicStatusPage(orgSlug: "x") { overallStatus }`;

// Throws on the first selection set walked twice, so a missing memo fails
// the test instead of hanging it.
const budget = () => {
  const seen = new Set<SelectionSetNode>();
  return (selectionSet: SelectionSetNode) => {
    if (seen.has(selectionSet)) throw new Error('selection set walked twice');
    seen.add(selectionSet);
  };
};
const budgeted = (query: string) =>
  validate(schema, parse(query), [
    createOnePublicPagePerOperation(budget()),
  ]).map((error) => error.message);

const chain = (depth: number, bottom: string, inline = false) => {
  const spread = (i: number) =>
    inline ? `... on Query { ...F${i + 1} }` : `...F${i + 1}`;
  return `{ ...F0 } ${[...Array(depth).keys()]
    .map((i) => `fragment F${i} on Query { ${spread(i)} ${spread(i)} }`)
    .join(' ')} fragment F${depth} on Query { ${bottom} }`;
};

describe('One public status page per operation', () => {
  before(async () => {
    schema = buildSchema(await getGQL());
  });

  it('allows one, however the caller writes it', () => {
    assert.deepEqual(errors(`{ ${page()} }`), []);
    assert.deepEqual(errors(`query Named { ${page('only')} }`), []);
  });

  it('refuses the same field aliased twice, which is how one request asks for a hundred', () => {
    const [message] = errors(`{ ${page('a')} ${page('b')} }`);
    assert.match(
      message,
      /may be selected once per operation; this one selects it 2 times/,
    );
    assert.equal(
      errors(
        `{ ${[...Array(100).keys()].map((n) => page(`a${n}`)).join(' ')} }`,
      ).length,
      1,
    );
  });

  it('follows fragments, spread and inline', () => {
    assert.equal(
      errors(
        `{ ...Twice } fragment Twice on Query { ${page('a')} ${page('b')} }`,
      ).length,
      1,
    );
    assert.equal(
      errors(`{ ...One ...One } fragment One on Query { ${page('a')} }`).length,
      1,
      'two spreads of one fragment are two selections here',
    );
    assert.equal(
      errors(`{ ... on Query { ${page('a')} ${page('b')} } }`).length,
      1,
    );
  });

  it('counts per operation, not per document', () => {
    // A document may carry several operations; each is executed on its own.
    assert.deepEqual(
      errors(`query A { ${page('a')} } query B { ${page('b')} }`),
      [],
    );
  });

  it('says nothing about other fields', () => {
    assert.deepEqual(errors('{ services { id } services { name } }'), []);
  });

  describe('bounded work on fragments', () => {
    it('walks a doubled chain once, without a page', () => {
      assert.deepEqual(budgeted(chain(16, '__typename')), []);
    });

    it('counts a doubled chain exactly', () => {
      const result = budgeted(chain(20, page()));
      assert.equal(result.length, 1);
      assert.match(result[0], /selects it 1048576 times$/);
    });

    it('counts a doubled chain exactly through inline fragments', () => {
      const result = budgeted(chain(16, page(), true));
      assert.equal(result.length, 1);
      assert.match(result[0], /selects it 65536 times$/);
    });

    it('saturates instead of losing precision', () => {
      const result = budgeted(chain(60, page()));
      assert.equal(result.length, 1);
      assert.match(result[0], /selects it at least 9007199254740991 times$/);
    });

    it('lets operations share a fragment', () => {
      assert.deepEqual(
        budgeted(
          `query A { ...P } query B { ...P } fragment P on Query { ${page()} }`,
        ),
        [],
      );
    });

    it('counts two spreads of a fragment in one operation twice', () => {
      const result = budgeted(
        `query A { ...P ...P } fragment P on Query { ${page()} }`,
      );
      assert.equal(result.length, 1);
      assert.match(result[0], /selects it 2 times$/);
    });

    it('keeps the memo per document', () => {
      const rule = createOnePublicPagePerOperation();
      const run = (query: string) =>
        validate(schema, parse(query), [rule]).map((e) => e.message);
      assert.deepEqual(run('{ ...P } fragment P on Query { __typename }'), []);
      const second = run(`{ ...P ...P } fragment P on Query { ${page()} }`);
      assert.equal(second.length, 1);
      assert.match(second[0], /selects it 2 times$/);
    });

    it('stays finite on a fragment cycle', () => {
      const query = `{ ...A } fragment A on Query { ...B ...B } fragment B on Query { ...A ...A ${page()} }`;
      const own = budgeted(query);
      assert.equal(own.length, 1);
      assert.match(own[0], /selects it 2 times$/);
      const all = validate(schema, parse(query), [
        ...specifiedRules,
        createOnePublicPagePerOperation(budget()),
      ]).map((e) => e.message);
      assert.ok(all.some((m) => m.includes('Cannot spread fragment')));
    });

    it('says nothing about an unknown fragment', () => {
      assert.deepEqual(budgeted('{ ...Missing }'), []);
    });

    it('finishes a depth-24 doubled chain quickly (backstop)', () => {
      const document = parse(chain(24, '__typename'));
      const start = performance.now();
      const result = validate(schema, document, [onePublicPagePerOperation]);
      const elapsed = performance.now() - start;
      assert.deepEqual(result, []);
      assert.ok(elapsed < 1000, `took ${elapsed} ms`);
    });
  });
});
