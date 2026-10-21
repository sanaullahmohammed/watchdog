import { NotFoundException } from '@/shared/exceptions';

/**
 * Pushes an organization's public page to its open streams when it changes
 * (story 4.6). Pure and timer-free: the route supplies `compose`, and each
 * stream supplies how to write and how to end.
 *
 * Compositions are coalesced per organization: at most one in flight and one
 * queued, however many requests arrive. Requests in the tick a composition
 * starts are covered by it, not queued behind it: the hub hands one signal to
 * each of an organization's streams in one synchronous loop, and the
 * composition's snapshot is taken after that loop, so it already sees what
 * the signal announced. A composition runs only while the
 * organization has a member, and its result is offered only to the members that
 * joined before it started, since it may hold an older snapshot than the first
 * page a later member was sent.
 *
 * The page is the gate: a member is sent a result only when its ETag differs
 * from the last page that member was sent. A member whose socket has not
 * drained is sent nothing; it keeps the newest result and gets it, if it still
 * differs, on `drained()`. So a member buffers at most one page.
 */

/** `orgId` is the organization the composed page belongs to, which a slug may no longer name. */
export type ComposedPage = { frame: string; etag: string; orgId: string };

export type PagePushLogger = {
  error(obj: object, msg: string): void;
};

export type PushMember = {
  slug: string;
  /** The ETag of the page this member was first sent. */
  etag: string;
  /** Writes a frame. */
  send(frame: string): void;
  /** False while the socket has not drained: nothing is written to it then. */
  writable(): boolean;
  /** Ends the stream; the route's idempotent cleanup. */
  end(): void;
};

export type JoinedMember = {
  leave(): void;
  /** The socket drained: send the newest page, if it differs from the last. */
  drained(): void;
};

export type PagePush = {
  join(orgId: string, member: PushMember): JoinedMember;
  request(orgId: string): void;
  close(): Promise<void>;
};

type State = {
  member: PushMember;
  lastEtag: string;
  pending: ComposedPage | undefined;
};

type Org = {
  members: Set<State>;
  slug: string;
  running: Promise<void> | undefined;
  /** True in the tick its composition started, which covers that tick's requests. */
  fresh: boolean;
  queued: boolean;
};

export function createPagePush({
  compose,
  log,
}: {
  compose(slug: string): Promise<ComposedPage>;
  log: PagePushLogger;
}): PagePush {
  const orgs = new Map<string, Org>();
  let closed = false;

  function transmit(state: State, page: ComposedPage) {
    if (page.etag === state.lastEtag) return;
    state.lastEtag = page.etag;
    state.member.send(page.frame);
  }

  function offer(state: State, page: ComposedPage) {
    if (!state.member.writable()) {
      // The latest page wins.
      state.pending = page;
      return;
    }
    transmit(state, page);
  }

  function forget(orgId: string, org: Org) {
    if (org.members.size === 0 && !org.running && orgs.get(orgId) === org) {
      orgs.delete(orgId);
    }
  }

  async function run(orgId: string, org: Org) {
    try {
      while (!closed) {
        org.queued = false;
        const cohort = [...org.members];
        if (cohort.length === 0) return;
        const slug = org.slug;
        let page: ComposedPage | undefined;
        try {
          page = await compose(slug);
        } catch (error) {
          if (!(error instanceof NotFoundException)) {
            log.error({ err: error, orgId }, 'Public page composition failed');
            if (!org.queued) return;
            continue;
          }
        }
        if (page && page.orgId === orgId) {
          for (const state of cohort) {
            if (org.members.has(state)) offer(state, page);
          }
          if (!org.queued) return;
          continue;
        }
        // A miss, or another organization's page: the slug no longer names
        // this one. Only the streams that joined under it end.
        for (const state of [...org.members]) {
          if (state.member.slug !== slug) continue;
          org.members.delete(state);
          state.member.end();
        }
        const remaining = [...org.members].at(-1);
        if (!remaining) return;
        org.slug = remaining.member.slug;
      }
    } finally {
      org.running = undefined;
      forget(orgId, org);
    }
  }

  return {
    join(orgId, member) {
      const state: State = {
        member,
        lastEtag: member.etag,
        pending: undefined,
      };
      if (closed) return { leave() {}, drained() {} };
      let org = orgs.get(orgId);
      if (!org) {
        org = {
          members: new Set(),
          slug: member.slug,
          running: undefined,
          fresh: false,
          queued: false,
        };
        orgs.set(orgId, org);
      }
      org.slug = member.slug;
      org.members.add(state);
      const own = org;
      return {
        leave() {
          own.members.delete(state);
          forget(orgId, own);
        },
        drained() {
          if (!state.member.writable()) return;
          const page = state.pending;
          state.pending = undefined;
          if (page) transmit(state, page);
        },
      };
    },

    request(orgId) {
      if (closed) return;
      const org = orgs.get(orgId);
      if (!org || org.members.size === 0) return;
      if (org.running) {
        if (!org.fresh) org.queued = true;
        return;
      }
      org.fresh = true;
      queueMicrotask(() => {
        org.fresh = false;
      });
      org.running = run(orgId, org).catch((error: unknown) =>
        log.error({ err: error, orgId }, 'Public page push failed'),
      );
    },

    async close() {
      closed = true;
      const running: Promise<void>[] = [];
      for (const org of orgs.values()) {
        org.queued = false;
        if (org.running) running.push(org.running);
      }
      await Promise.all(running);
    },
  };
}
