import GracefulServer from '@gquittet/graceful-server';
import { env } from '@/config';
import { buildApp } from '@/server/build-app';
import sql, { closeDbConnection } from '@/shared/db/postgres';
import { assertTenantBoundRole } from '@/shared/db/runtime-role';

export async function startApi() {
  const fastify = await buildApp();

  // Before listening: a role exempt from RLS would serve every tenant's rows.
  try {
    await assertTenantBoundRole(sql);
  } catch (error) {
    fastify.log.fatal(error);
    process.exit(1);
  }

  const gracefulServer = GracefulServer(fastify.server, {
    // graceful-server closes the HTTP server itself and then awaits these. It
    // does not close Fastify, so closing it here is what runs the onClose
    // hooks - draining event handlers whose work is still in flight - and it
    // has to happen before the connection pool goes.
    closePromises: [() => fastify.close(), closeDbConnection],
  });

  gracefulServer.on(GracefulServer.READY, () => {
    fastify.log.info('Server is ready');
  });

  gracefulServer.on(GracefulServer.SHUTTING_DOWN, () => {
    fastify.log.info('Server is shutting down');
  });

  gracefulServer.on(GracefulServer.SHUTDOWN, (error) => {
    fastify.log.info('Server is down because of', error.message);
  });

  try {
    await fastify.listen({ host: env.server.host, port: env.server.port });
    gracefulServer.setReady();
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}
