import fp from 'fastify-plugin';
import {
  createRealtimeHub,
  type RealtimeHub,
} from '@/shared/realtime/realtime-hub';

/**
 * Gives every app its realtime hub (story 4.4). Cheap and connection-free, so
 * every app has one, whether it listens or not: only an app built with
 * `listen: true` feeds it (`src/server/realtime/listener.ts`). Wrapped in
 * `fastify-plugin` so the decoration is visible outside this plugin.
 *
 * Closing the app sends every subscriber `closed`, so no stream or
 * subscription holds shutdown open. In `preClose`, not `onClose`: Fastify
 * registers its own `onClose` (`closeIdleConnections`, then `server.close`)
 * after every plugin's, and avvio runs `onClose` hooks last-in-first-out, so
 * `server.close` would run first and wait forever on an open stream whose
 * `closed` never came. `preClose` runs before it; a stream that hears
 * `closed` ends its response, which leaves its connection idle, and Fastify
 * then closes that connection (story 4.5). The listener's own `onClose`
 * (`src/server/realtime/listener.ts`) still runs after this, so `closed`
 * still precedes the unlisten.
 */
const realtimePlugin = fp(
  (fastify, _opts, done) => {
    const hub = createRealtimeHub(fastify.log);
    fastify.decorate('realtimeHub', hub);
    fastify.addHook('preClose', async () => {
      hub.close();
    });
    done();
  },
  {
    name: 'realtime-hub',
    fastify: '5.x',
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    realtimeHub: RealtimeHub;
  }
}

export default realtimePlugin;
