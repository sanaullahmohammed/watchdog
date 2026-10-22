import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildNotificationEmail,
  type NotificationSource,
} from './notification-email';

const base = {
  to: 'a@example.test',
  orgName: 'Acme',
  orgSlug: 'acme',
  publicBaseUrl: 'https://status.example.com',
  unsubscribeUrl:
    'https://status.example.com/status/acme/subscribers/unsubscribe?x=1',
};
const window = {
  title: 'DB upgrade',
  description: null,
  scheduledStartAt: new Date('2026-10-22T14:05:00Z'),
  scheduledEndAt: new Date('2026-10-22T15:30:00Z'),
  startedAt: null,
  completedAt: null,
};

const build = (source: NotificationSource) =>
  buildNotificationEmail({ ...base, source });

function assertFooter(text: string) {
  assert.match(text, /https:\/\/status\.example\.com\/status\/acme\n/);
  assert.ok(text.includes(base.unsubscribeUrl));
  assert.ok(text.trimEnd().endsWith(base.unsubscribeUrl));
}

describe('story 6.7: buildNotificationEmail', () => {
  it('words an incident update', () => {
    const email = build({
      sourceType: 'incident_update',
      incidentTitle: 'API down',
      status: 'investigating',
      message: 'We are looking.',
      postedAt: new Date('2026-10-22T14:05:00Z'),
    });
    assert.equal(email.subject, '[Acme] API down: Investigating');
    assert.match(email.text, /Investigating/);
    assert.match(email.text, /We are looking\./);
    assert.match(email.text, /2026-10-22 14:05 UTC/);
    assertFooter(email.text);
  });

  it('words a scheduled window, with its description', () => {
    const email = build({
      sourceType: 'maintenance_scheduled',
      ...window,
      description: 'Expect a short outage.',
    });
    assert.equal(email.subject, '[Acme] Maintenance scheduled: DB upgrade');
    assert.match(email.text, /2026-10-22 14:05 UTC/);
    assert.match(email.text, /2026-10-22 15:30 UTC/);
    assert.match(email.text, /Expect a short outage\./);
    assertFooter(email.text);
  });

  it('words a started window', () => {
    const email = build({
      sourceType: 'maintenance_started',
      ...window,
      startedAt: new Date('2026-10-22T14:06:00Z'),
    });
    assert.equal(email.subject, '[Acme] Maintenance started: DB upgrade');
    assert.match(email.text, /2026-10-22 14:06 UTC/);
    assert.match(email.text, /2026-10-22 15:30 UTC/);
    assertFooter(email.text);
  });

  it('words a completed window', () => {
    const email = build({
      sourceType: 'maintenance_completed',
      ...window,
      startedAt: new Date('2026-10-22T14:06:00Z'),
      completedAt: new Date('2026-10-22T15:10:00Z'),
    });
    assert.equal(email.subject, '[Acme] Maintenance completed: DB upgrade');
    assert.match(email.text, /2026-10-22 15:10 UTC/);
    assertFooter(email.text);
  });

  it('words a completion that never started', () => {
    const email = build({
      sourceType: 'maintenance_completed',
      ...window,
      completedAt: new Date('2026-10-22T15:10:00Z'),
    });
    assert.equal(
      email.subject,
      '[Acme] Maintenance ended without starting: DB upgrade',
    );
    assert.match(
      email.text,
      /This maintenance window ended without starting\./,
    );
    assert.match(email.text, /2026-10-22 14:05 UTC/);
    assertFooter(email.text);
  });

  it('carries both List-Unsubscribe headers', () => {
    const email = build({ sourceType: 'maintenance_scheduled', ...window });
    assert.deepEqual(email.headers, {
      'List-Unsubscribe': `<${base.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('turns subject line breaks into spaces', () => {
    const email = build({
      sourceType: 'maintenance_scheduled',
      ...window,
      title: 'a\r\nb\nc',
    });
    assert.doesNotMatch(email.subject, /[\r\n]/);
    assert.equal(email.subject, '[Acme] Maintenance scheduled: a b c');
  });
});
