/**
 * A counting limiter. The cap is read each time a waiting task is considered,
 * so lowering it takes effect for everything not yet admitted.
 */
export function createLimiter(cap: () => number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  const admit = () => {
    while (waiting.length > 0 && active < cap()) {
      active += 1;
      waiting.shift()?.();
    }
  };

  return {
    /** Runs `task` once a slot is free and holds the slot until it settles. */
    async run<T>(task: () => Promise<T>): Promise<T> {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        admit();
      });
      try {
        return await task();
      } finally {
        active -= 1;
        admit();
      }
    },
    get active() {
      return active;
    },
  };
}
