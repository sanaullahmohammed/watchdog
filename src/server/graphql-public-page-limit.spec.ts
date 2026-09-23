import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { buildSchema, type GraphQLSchema, parse, validate } from 'graphql';
import { onePublicPagePerOperation } from '@/server/graphql-public-page-limit';
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
});
