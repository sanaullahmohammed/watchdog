import { createHash } from 'node:crypto';
import { describeChange } from '@/modules/notification/domain/notification-email';
import type { AtomFeedView } from '@/modules/notification/queries/get-atom-feed/get-atom-feed.handler';

/**
 * The Atom document (RFC 4287) for the public feed, built by hand: the
 * runtime takes no XML dependency. Story 6.8.
 */

// Anything XML 1.0 forbids: controls other than tab, LF and CR, lone
// surrogates (with the `u` flag they read as the code points D800-DFFF, which
// the allowed ranges leave out), U+FFFE and U+FFFF.
const FORBIDDEN_XML =
  /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/**
 * Text safe for an element or a double-quoted attribute: forbidden characters
 * removed, `& < > "` escaped, and a carriage return written as `&#13;` so a
 * CRLF survives an XML parser's line-end normalisation.
 */
export function escapeXml(text: string): string {
  return text
    .replace(FORBIDDEN_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;');
}

/** A strong entity tag over the body: the body holds no generation time. */
export function atomFeedETag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/**
 * The `tag:` URI every id of the feed starts from (RFC 4151). The authority
 * is the public base URL's host, which is a DNS name or an IPv4 literal; an
 * IPv6 literal is not allowed there, so it becomes `localhost`. The date is
 * the organization's creation, so the id stays the same for its life while
 * that host does. Changing `PUBLIC_BASE_URL`'s host changes every id, and
 * readers see the feed as new (accepted).
 */
export function feedId(
  organization: AtomFeedView['organization'],
  publicBaseUrl: string,
): string {
  const { hostname } = new URL(publicBaseUrl);
  const authority =
    hostname === '' || hostname.startsWith('[') ? 'localhost' : hostname;
  return `tag:${authority},${organization.createdAt.toISOString().slice(0, 10)}:${organization.id}`;
}

const MAINTENANCE_PHASE = {
  maintenance_scheduled: 'scheduled',
  maintenance_started: 'started',
  maintenance_completed: 'completed',
} as const;

export function toAtomFeed(view: AtomFeedView, publicBaseUrl: string): string {
  const { organization, entries } = view;
  const base = feedId(organization, publicBaseUrl);
  const page = `${publicBaseUrl}/status/${organization.slug}`;
  const updated = entries[0]?.at ?? organization.createdAt;

  const entryXml = entries.map((entry) => {
    const { title, lines } = describeChange(entry.source);
    const id =
      entry.sourceType === 'incident_update'
        ? `${base}/incident-update/${entry.sourceId}`
        : `${base}/maintenance/${entry.sourceId}/${MAINTENANCE_PHASE[entry.sourceType]}`;
    return [
      '  <entry>',
      `    <id>${escapeXml(id)}</id>`,
      `    <title>${escapeXml(title)}</title>`,
      `    <updated>${entry.at.toISOString()}</updated>`,
      `    <link rel="alternate" href="${escapeXml(page)}"/>`,
      `    <content type="text">${escapeXml(lines.join('\n'))}</content>`,
      '  </entry>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(base)}</id>`,
    `  <title>${escapeXml(`${organization.name} status`)}</title>`,
    `  <updated>${updated.toISOString()}</updated>`,
    `  <author><name>${escapeXml(organization.name)}</name></author>`,
    `  <link rel="alternate" href="${escapeXml(page)}"/>`,
    `  <link rel="self" href="${escapeXml(`${page}/feed.atom`)}"/>`,
    ...entryXml,
    '</feed>',
    '',
  ].join('\n');
}
