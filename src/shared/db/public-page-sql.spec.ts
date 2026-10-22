import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  publicTimelineEntry,
  RESERVED_ALIAS,
  visibleService,
} from '@/shared/db/public-page-sql';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * Story 6.6: the public rule's SQL fragments refuse the alias their own inner
 * read uses, which would otherwise shadow the caller's row. What they select
 * is proved against the database by the status page's and the notification
 * pass's integration suites. Needs no database; runs with the unit suite.
 */

// Never reached: the alias is refused before any SQL is built.
const tx = {
  orgId: 'org',
  get sql(): never {
    throw new Error('built SQL for a refused alias');
  },
} as unknown as TenantTransaction;

describe('the public rule fragments', () => {
  it('refuse the reserved inner alias as the caller s alias', () => {
    for (const fragment of [visibleService, publicTimelineEntry]) {
      assert.throws(
        () => fragment(tx, RESERVED_ALIAS),
        new RegExp(`${RESERVED_ALIAS} is reserved`),
        fragment.name,
      );
    }
  });
});
