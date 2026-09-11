import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedTransitions } from '@/modules/incident/domain/incident.state-machine';
import {
  timelineEntryMessage,
  timelineMessageFor,
} from '@/modules/incident/domain/incident-timeline';

describe('timelineMessageFor', () => {
  it('has something to say for every legal transition, the declaration included', () => {
    for (const [from, to] of allowedTransitions()) {
      const message = timelineMessageFor(from, to);
      assert.equal(typeof message, 'string');
      assert.ok(
        message.trim().length > 0,
        `${from ?? '[none]'} -> ${to} has no message`,
      );
    }
  });

  it('never words a dismissed draft as a resolution', () => {
    // Both land on `resolved`, but customers were never told about a draft.
    assert.doesNotMatch(timelineMessageFor('draft', 'resolved'), /resolved/i);
    assert.match(timelineMessageFor('investigating', 'resolved'), /resolved/i);
  });

  it('tells a confirmed draft apart from a fresh declaration', () => {
    assert.notEqual(
      timelineMessageFor('draft', 'investigating'),
      timelineMessageFor(null, 'investigating'),
    );
  });
});

describe('timelineEntryMessage', () => {
  it("keeps the operator's words", () => {
    assert.equal(
      timelineEntryMessage('Rolling back.', 'investigating', 'identified'),
      'Rolling back.',
    );
  });

  it('falls back to the default when there are none, blank included', () => {
    const fallback = timelineMessageFor('investigating', 'identified');
    for (const given of [undefined, null, '', '   ']) {
      assert.equal(
        timelineEntryMessage(given, 'investigating', 'identified'),
        fallback,
      );
    }
  });
});
