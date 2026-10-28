import sql from '@/shared/db/postgres';

/**
 * Holds a tenant transaction open on its own connection. `work` runs first;
 * the transaction commits once `commit()` is called. `pid` is its backend.
 */
export async function holdTransaction(
  orgId: string,
  work: (tx: typeof sql) => Promise<unknown>,
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: (pid: number) => void;
  let failed!: (error: unknown) => void;
  const started = new Promise<number>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = sql.begin(async (raw) => {
    const tx = raw as unknown as typeof sql;
    await tx`select set_config('app.current_org_id', ${orgId}, true)`;
    const [{ pid }] = await tx<
      { pid: number }[]
    >`select pg_backend_pid() as pid`;
    await work(tx);
    ready(pid);
    await released;
  });
  // A failure in `work` must not leave the test waiting for `started`.
  done.catch(failed);
  const pid = await started;
  return {
    pid,
    async commit() {
      release();
      await done;
    },
  };
}

/** Waits until some backend is blocked by `pid`, as `pg_blocking_pids` says. */
export async function waitUntilBlockedBy(pid: number, what: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ blocked }] = await sql<{ blocked: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity
        where ${pid} = any(pg_blocking_pids(pid))
      ) as blocked
    `;
    if (blocked) return;
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited on the test's transaction`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
