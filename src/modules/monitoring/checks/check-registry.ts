/**
 * The monitors with a check queued or running in this process. It guarantees
 * one check per monitor at a time, and it is how the worker tells a backlog
 * from a stall (ARCHITECTURE 6.0.1).
 *
 * A check settles only when its task fulfils: it was recorded, or rightly
 * skipped. A task that rejects does not settle; its failure stays pending, even
 * after the registry empties, until a later check settles or `idle()` says a
 * tick found nothing due. The clock restarts when the registry goes from empty
 * to non-empty, unless a failure is pending.
 */
export function createCheckRegistry(
  // Monotonic: the wall clock steps back on some machines.
  clock: () => number = () => performance.now(),
) {
  const pending = new Map<string, Promise<unknown>>();
  let lastSettledAt = clock();
  let failurePending = false;

  return {
    /**
     * Registers `id` and runs `task`, releasing the id in a `finally` on every
     * outcome. Returns null, without running, when `id` is already registered.
     * The returned promise carries the task's result or rejection.
     */
    start<T>(id: string, task: () => Promise<T>): Promise<T> | null {
      if (pending.has(id)) return null;
      if (pending.size === 0 && !failurePending) lastSettledAt = clock();
      // Started on a later microtask, so a task that throws at once is still
      // released after it is registered, not before.
      const promise: Promise<T> = Promise.resolve()
        .then(task)
        .then(
          (value) => {
            lastSettledAt = clock();
            failurePending = false;
            return value;
          },
          (error: unknown) => {
            failurePending = true;
            throw error;
          },
        )
        .finally(() => {
          // After reset() a newer task may hold this id.
          if (pending.get(id) === promise) pending.delete(id);
        });
      pending.set(id, promise);
      return promise;
    },
    has(id: string) {
      return pending.has(id);
    },
    get size() {
      return pending.size;
    },
    /**
     * True when work is unsettled (checks registered, or a failure pending) and
     * nothing has settled for `overdueMs`.
     */
    stalled(overdueMs: number) {
      return (
        (pending.size > 0 || failurePending) &&
        clock() - lastSettledAt >= overdueMs
      );
    },
    /** A tick found nothing due and nothing registered: a failure is moot. */
    idle() {
      if (pending.size === 0) failurePending = false;
    },
    /** Resolves once the registry is empty, whatever the checks' outcomes. */
    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending.values()]);
      }
    },
    /** Test-only: forget everything. */
    reset() {
      pending.clear();
      failurePending = false;
      lastSettledAt = clock();
    },
  };
}
