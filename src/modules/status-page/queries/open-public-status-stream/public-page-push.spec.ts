import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundException } from '@/shared/exceptions';
import { type ComposedPage, createPagePush } from './public-page-push';

/**
 * Story 4.6: the push's coalescing, gate, failure and backpressure rules.
 * Needs no database; runs with the unit suite.
 */

const page = (n: number | string, orgId = 'o'): ComposedPage => ({
  frame: `id: "${n}"\ndata: {}\n\n`,
  etag: `"${n}"`,
  orgId,
});

/** A compose the test releases by hand, one call at a time. */
function heldCompose() {
  const calls: Array<{
    slug: string;
    resolve(p: ComposedPage): void;
    reject(e: unknown): void;
  }> = [];
  return {
    calls,
    compose: (slug: string) =>
      new Promise<ComposedPage>((resolve, reject) => {
        calls.push({ slug, resolve, reject });
      }),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function member(
  etag: string,
  opts: { full?: boolean; slug?: string; throws?: boolean } = {},
) {
  const sent: string[] = [];
  let ended = 0;
  let full = opts.full ?? false;
  return {
    sent,
    get ended() {
      return ended;
    },
    setFull: (value: boolean) => {
      full = value;
    },
    spec: {
      slug: opts.slug ?? 'acme',
      etag,
      writable: () => !full,
      send: (frame: string) => {
        if (opts.throws) throw new Error('write failed');
        sent.push(frame);
      },
      end: () => {
        ended += 1;
      },
    },
  };
}

const logger = () => {
  const errors: object[] = [];
  return { errors, log: { error: (obj: object) => errors.push(obj) } };
};

describe('Page push', () => {
  it('sends a changed page once, and skips one equal to the last sent', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    const b = member('"2"');
    push.join('o', a.spec);
    push.join('o', b.spec);

    push.request('o');
    calls[0].resolve(page(2));
    await tick();

    assert.deepEqual(a.sent, [page(2).frame]);
    assert.deepEqual(b.sent, [], 'its last page already equals the result');
  });

  it('coalesces a burst into two compositions and sends the final page once', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    push.join('o', a.spec);

    push.request('o');
    await tick();
    for (let n = 0; n < 5; n += 1) push.request('o');
    assert.equal(calls.length, 1);
    calls[0].resolve(page(2));
    await tick();
    assert.equal(calls.length, 2);
    calls[1].resolve(page(3));
    await tick();

    assert.equal(calls.length, 2);
    assert.deepEqual(a.sent, [page(2).frame, page(3).frame]);
  });

  it('covers requests made in the tick a composition starts, rather than queueing one', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    push.join('o', a.spec);

    // The hub hands one signal to each of the org's streams in one loop.
    for (let n = 0; n < 3; n += 1) push.request('o');
    calls[0].resolve(page(2));
    await tick();

    assert.equal(calls.length, 1);
    assert.deepEqual(a.sent, [page(2).frame]);
  });

  it('composes nothing for an org with no member', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    push.request('nobody');
    const a = member('"1"');
    const joined = push.join('o', a.spec);
    joined.leave();
    push.request('o');
    assert.equal(calls.length, 0);
  });

  it('offers a result only to members that joined before it started', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const early = member('"1"');
    push.join('o', early.spec);
    push.request('o');
    const late = member('"5"');
    push.join('o', late.spec);
    calls[0].resolve(page(2));
    await tick();

    assert.deepEqual(early.sent, [page(2).frame]);
    assert.deepEqual(late.sent, [], 'never an older page than its own');
  });

  it('sends nothing to a member that left mid-composition', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    const joined = push.join('o', a.spec);
    push.request('o');
    joined.leave();
    calls[0].resolve(page(2));
    await tick();
    assert.deepEqual(a.sent, []);
  });

  it('logs a failed composition, keeps the members, and retries on the next request', async () => {
    const { compose, calls } = heldCompose();
    const { log, errors } = logger();
    const push = createPagePush({ compose, log });
    const a = member('"1"');
    push.join('o', a.spec);

    push.request('o');
    calls[0].reject(new Error('boom'));
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(a.ended, 0);

    push.request('o');
    calls[1].resolve(page(2));
    await tick();
    assert.deepEqual(a.sent, [page(2).frame]);
  });

  it('ends the members of an org whose page is gone, and drops the queued run', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    const b = member('"1"');
    push.join('o', a.spec);
    push.join('o', b.spec);
    push.request('o');
    push.request('o');
    calls[0].reject(new NotFoundException('Status page not found'));
    await tick();

    assert.equal(a.ended, 1);
    assert.equal(b.ended, 1);
    assert.equal(calls.length, 1, 'the queued run was dropped');
    push.request('o');
    assert.equal(calls.length, 1, 'and the org was cleared');
  });

  it('holds only the newest page for a member that cannot write', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    const joined = push.join('o', a.spec);

    a.setFull(true);
    for (const n of [2, 3, 4]) {
      push.request('o');
      calls[n - 2].resolve(page(n));
      await tick();
    }
    assert.deepEqual(a.sent, [], 'nothing while it waits');

    joined.drained();
    assert.deepEqual(a.sent, [], 'still not writable');
    a.setFull(false);
    joined.drained();
    assert.deepEqual(a.sent, [page(4).frame]);
    joined.drained();
    assert.equal(a.sent.length, 1, 'once');
  });

  it('sends nothing on drain when the newest page equals the last sent, for a member that joined unable to write', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"', { full: true });
    const joined = push.join('o', a.spec);

    push.request('o');
    calls[0].resolve(page(2));
    await tick();
    push.request('o');
    calls[1].resolve(page(1));
    await tick();
    a.setFull(false);
    joined.drained();
    assert.deepEqual(a.sent, []);
  });

  it('ends only the members of a slug that now names another organization', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const old = member('"1"', { slug: 'old' });
    const fresh = member('"1"', { slug: 'new' });
    push.join('o', old.spec);
    push.request('o');
    push.join('o', fresh.spec);
    calls[0].resolve(page(2, 'someone-else'));
    await tick();

    assert.equal(old.ended, 1);
    assert.equal(fresh.ended, 0);
    assert.equal(calls.length, 2, 'composed again under the new slug');
    assert.equal(calls[1].slug, 'new');
    calls[1].resolve(page(3));
    await tick();
    assert.deepEqual(fresh.sent, [page(3).frame]);
    assert.deepEqual(old.sent, []);
  });

  it('survives a miss on the old slug for a member on the new one', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const old = member('"1"', { slug: 'old' });
    const fresh = member('"1"', { slug: 'new' });
    push.join('o', old.spec);
    push.request('o');
    push.join('o', fresh.spec);
    calls[0].reject(new NotFoundException('Status page not found'));
    await tick();

    assert.equal(old.ended, 1);
    assert.equal(fresh.ended, 0);
    assert.equal(calls[1].slug, 'new');
    calls[1].resolve(page(2));
    await tick();
    assert.deepEqual(fresh.sent, [page(2).frame]);
  });

  it('logs a member whose send throws, and close still resolves', async () => {
    const { compose, calls } = heldCompose();
    const { log, errors } = logger();
    const push = createPagePush({ compose, log });
    const a = member('"1"', { throws: true });
    push.join('o', a.spec);
    push.request('o');
    calls[0].resolve(page(2));
    await tick();

    assert.equal(errors.length, 1);
    await push.close();
  });

  it('close drops queued runs, refuses later requests, and waits for the one in flight', async () => {
    const { compose, calls } = heldCompose();
    const push = createPagePush({ compose, log: logger().log });
    const a = member('"1"');
    push.join('o', a.spec);
    push.request('o');
    push.request('o');

    let settled = false;
    const closing = push.close().then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false);
    calls[0].resolve(page(2));
    await closing;

    assert.equal(calls.length, 1);
    push.request('o');
    assert.equal(calls.length, 1);
  });
});
