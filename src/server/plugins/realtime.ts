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
 * subscription holds shutdown open.
 */
const realtimePlugin = fp(
  (fastify, _opts, done) => {
    const hub = createRealtimeHub(fastify.log);
    fastify.decorate('realtimeHub', hub);
    fastify.addHook('onClose', async () => {
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
