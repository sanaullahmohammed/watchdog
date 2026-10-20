import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { env } from '@/config';
import { sqlDebugOption } from '@/shared/db/sql-debug';
import { startNotifyListener } from '@/shared/realtime/notify-listener';

/**
 * Starts the app's `LISTEN` on a connection of its own (story 4.4,
 * ARCHITECTURE.md 5.4). Only `buildApp(…, { listen: true })` calls this, and
 * only the api asks; the worker never listens.
 *
 * Not the shared pool: its listen client ends only with the pool, and the
 * entrypoint closes the pool after `app.close()`. A client of its own ends in
 * this app's `onClose`, and its name, `watchdog-listener:<pid>`, finds it in
 * `pg_stat_activity`.
 */
export async function startRealtimeListener(
  app: FastifyInstance,
): Promise<void> {
  const sql = postgres(env.db.url, {
    max: 1,
    connection: { application_name: `watchdog-listener:${process.pid}` },
    ...sqlDebugOption(env.log.level, () => app.log),
  });

  const listener = await startNotifyListener({
    sql,
    hub: app.realtimeHub,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    // Subscribers hear `closed` before the connection goes, whichever order
    // Fastify runs the hooks in. Closing the hub twice is a no-op.
    app.realtimeHub.close();
    await listener.close();
  });
}
