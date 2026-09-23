import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicPageETag } from '@/modules/status-page/dtos/public-status-page.etag';
import type { PublicStatusPageResponseDto } from '@/modules/status-page/dtos/public-status-page.response.dto';

/** Epic 3 retrospective, action item 16 (R-5): a tag a poller can act on. */

const page = (
  overrides: Partial<PublicStatusPageResponseDto> = {},
): PublicStatusPageResponseDto => ({
  organization: { name: 'Acme Cloud', slug: 'acme' },
  overallStatus: 'operational',
  generatedAt: '2026-09-23T10:00:00.000Z',
  groups: [],
  activeIncidents: [],
  maintenance: [],
  uptime: { windowDays: 90, services: [] },
  ...overrides,
});

describe('publicPageETag', () => {
  it('ignores generatedAt, which changes on every response', () => {
    // Without this a tag never matches and no poll is ever answered 304.
    assert.equal(
      publicPageETag(page()),
      publicPageETag(page({ generatedAt: '2026-09-23T11:22:33.444Z' })),
    );
  });

  it('changes when anything a reader would see changes', () => {
    const base = publicPageETag(page());
    assert.notEqual(base, publicPageETag(page({ overallStatus: 'degraded' })));
    assert.notEqual(
      base,
      publicPageETag(page({ organization: { name: 'Acme', slug: 'acme' } })),
    );
    assert.notEqual(
      base,
      publicPageETag(
        page({
          activeIncidents: [
            {
              id: '00000000-0000-0000-0000-000000000000',
              title: 'Something',
              impact: 'minor',
              status: 'investigating',
              startedAt: '2026-09-23T09:00:00.000Z',
              affectedServiceIds: [],
              updates: [],
            },
          ],
        }),
      ),
    );
  });

  it('is a quoted entity tag, as the header wants', () => {
    assert.match(publicPageETag(page()), /^"[\w-]+"$/);
  });
});
