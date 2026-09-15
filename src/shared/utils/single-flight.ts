/**
 * Runs an async task, never twice at once.
 *
 * A call made while a run is in flight returns that run rather than starting a
 * second one, and `inFlight` lets a shutdown await whatever is running. The
 * worker's maintenance pass needs both: a pass that outlasts its interval
 * would otherwise overlap the next tick, and the passes would contend on the
 * same rows and pile up on the connection pool.
 */
export function singleFlight(task: () => Promise<void>) {
  let current: Promise<void> | null = null;

  return {
    /** The run in flight, or null when idle. */
    get inFlight(): Promise<void> | null {
      return current;
    },

    /** Starts the task, or returns the run already in flight. */
    run(): Promise<void> {
      if (current) {
        return current;
      }
      // Cleared on settle, failure included: one failed run must not wedge the
      // gate shut for the life of the process.
      const started: Promise<void> = task().finally(() => {
        if (current === started) {
          current = null;
        }
      });
      current = started;
      return started;
    },
  };
}
