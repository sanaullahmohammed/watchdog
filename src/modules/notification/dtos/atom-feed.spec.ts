import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import type { AtomFeedEntry } from '@/modules/notification/queries/get-atom-feed/get-atom-feed.handler';
import { atomFeedETag, escapeXml, feedId, toAtomFeed } from './atom-feed';

const organization = {
  id: 'org1234567890123456789012345678ab',
  name: 'Acme <&> "Co"',
  slug: 'acme',
  createdAt: new Date('2026-03-04T23:59:59Z'),
};
const BASE = 'https://status.example.com';
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  htmlEntities: true,
});

const entry: AtomFeedEntry = {
  sourceType: 'incident_update' as const,
  sourceId: 'u1',
  at: new Date('2026-10-22T14:05:00.123Z'),
  position: { at: '', sourceId: 'u1', rank: 0 },
  affectedServiceIds: [],
  source: {
    sourceType: 'incident_update' as const,
    incidentTitle: '<b>&"\'\u0001',
    status: 'investigating',
    message: 'line one\r\nline two',
    postedAt: new Date('2026-10-22T14:05:00.123Z'),
  },
};

describe('story 6.8: escapeXml', () => {
  it('escapes & < > " and writes CR as a character reference', () => {
    assert.equal(
      escapeXml('a&b<c>d"e\r\nf'),
      'a&amp;b&lt;c&gt;d&quot;e&#13;\nf',
    );
  });

  it('removes what XML 1.0 forbids and keeps what it allows', () => {
    assert.equal(escapeXml('a\u0001\u0008\u000b\u000c\u001f￾￿b'), 'ab');
    assert.equal(escapeXml('x\ud800y'), 'xy');
    assert.equal(escapeXml('t\tn\n\u{1F600}'), 't\tn\n\u{1F600}');
  });
});

describe('story 6.8: toAtomFeed', () => {
  it('writes an empty feed whose updated is the creation time', () => {
    const xml = toAtomFeed({ organization, entries: [] }, BASE);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n'));
    const feed = parser.parse(xml).feed;
    assert.equal(feed['@_xmlns'], 'http://www.w3.org/2005/Atom');
    assert.equal(feed.updated, '2026-03-04T23:59:59.000Z');
    assert.equal(feed.title, 'Acme <&> "Co" status');
    assert.equal(feed.author.name, 'Acme <&> "Co"');
    assert.equal(feed.entry, undefined);
    assert.equal(
      feed.id,
      `tag:status.example.com,2026-03-04:${organization.id}`,
    );
    const rels = feed.link.map((l: Record<string, string>) => [
      l['@_rel'],
      l['@_href'],
    ]);
    assert.deepEqual(rels, [
      ['alternate', `${BASE}/status/acme`],
      ['self', `${BASE}/status/acme/feed.atom`],
    ]);
  });

  it('round-trips an entry and drops the forbidden character', () => {
    const view = { organization, entries: [entry] };
    const feed = parser.parse(toAtomFeed(view, BASE)).feed;
    assert.equal(feed.updated, '2026-10-22T14:05:00.123Z');
    assert.equal(feed.entry.title, '<b>&"\': Investigating');
    assert.equal(feed.entry.id, `${feed.id}/incident-update/u1`);
    assert.equal(feed.entry.content['@_type'], 'text');
    assert.match(feed.entry.content['#text'], /line one\r\nline two/);
  });

  it('is the same body, and tag, for the same state', () => {
    const a = toAtomFeed({ organization, entries: [] }, BASE);
    assert.equal(
      atomFeedETag(a),
      atomFeedETag(toAtomFeed({ organization, entries: [] }, BASE)),
    );
    assert.match(atomFeedETag(a), /^"[\w-]+"$/);
  });
});

describe('story 6.8: feedId', () => {
  it('uses the host, and localhost for an IPv6 literal', () => {
    assert.equal(
      feedId(organization, 'http://localhost:3000'),
      `tag:localhost,2026-03-04:${organization.id}`,
    );
    assert.equal(
      feedId(organization, 'http://[::1]:3000'),
      `tag:localhost,2026-03-04:${organization.id}`,
    );
  });
});
