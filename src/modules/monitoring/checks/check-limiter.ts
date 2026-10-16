/**
 * A counting limiter. The cap is read each time a waiting task is considered,
 * so lowering it takes effect for everything not yet admitted. Waiting tasks
 * are admitted round-robin across keys, first in first out within a key, so
 * one key with a long queue cannot hold the others back.
 */
export class LimiterClosedError extends Error {
  constructor() {
    super('the check limiter is closed');
    this.name = 'LimiterClosedError';
  }
}

export function createLimiter(cap: () => number) {
  let active = 0;
  // Every key with a task waiting or running. `lastServed` orders the rotation:
  // the next admission goes to the waiting key served longest ago, and a key
  // never served goes first.
  type Waiter = { start: () => void; reject: (error: Error) => void };
  const keys = new Map<
    string,
    { waiting: Waiter[]; running: number; lastServed: number }
  >();
  let admissions = 0;
  let closed = false;

  const admit = () => {
    while (active < cap()) {
      let next: ReturnType<typeof keys.get>;
      for (const state of keys.values()) {
        if (
          state.waiting.length > 0 &&
          (next === undefined || state.lastServed < next.lastServed)
        ) {
          next = state;
        }
      }
      if (next === undefined) return;
      admissions += 1;
      next.lastServed = admissions;
      next.running += 1;
      active += 1;
      next.waiting.shift()?.start();
    }
  };

  return {
    /** Runs `task` once a slot is free and holds the slot until it settles. */
    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
      if (closed) throw new LimiterClosedError();
      let state = keys.get(key);
      if (state === undefined) {
        state = { waiting: [], running: 0, lastServed: 0 };
        keys.set(key, state);
      }
      const own = state;
      await new Promise<void>((start, reject) => {
        own.waiting.push({ start, reject });
        admit();
      });
      try {
        return await task();
      } finally {
        active -= 1;
        own.running -= 1;
        if (own.running === 0 && own.waiting.length === 0) {
          keys.delete(key);
        }
        admit();
      }
    },
    /**
     * Stops taking new work: every waiting `run` rejects with
     * LimiterClosedError without starting its task, and so does every later
     * `run`. Tasks already running finish.
     */
    close() {
      closed = true;
      for (const [key, state] of keys) {
        for (const waiter of state.waiting.splice(0)) {
          waiter.reject(new LimiterClosedError());
        }
        if (state.running === 0) keys.delete(key);
      }
    },
    get active() {
      return active;
    },
  };
}
