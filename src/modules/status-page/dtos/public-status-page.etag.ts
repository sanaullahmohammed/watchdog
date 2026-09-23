import { createHash } from 'node:crypto';
import type { PublicStatusPageResponseDto } from '@/modules/status-page/dtos/public-status-page.response.dto';

/**
 * An entity tag over everything the page says except when it said it.
 *
 * `generatedAt` changes on every response, so a tag over the whole body would
 * never match and a poller could never be told "nothing changed" (Epic 3
 * retrospective, R-5). Hashing the body without it makes the tag describe the
 * organization's state, which is what a poller is asking about.
 *
 * Strong rather than weak: two bodies with the same tag differ only in
 * `generatedAt`, and a client that received one has nothing to gain from the
 * other.
 */
export function publicPageETag(page: PublicStatusPageResponseDto): string {
  const { generatedAt: _, ...state } = page;
  const digest = createHash('sha256')
    .update(JSON.stringify(state))
    .digest('base64url');

  return `"${digest}"`;
}
