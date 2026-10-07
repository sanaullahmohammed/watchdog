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
    // graceful-server waits its timeout, awaits these steps in order (because
    // of syncClose; otherwise they run in parallel), then closes sockets and
    // the server, then exits the process itself. Closing Fastify runs the
    // onClose hooks - draining event handlers and ending the auth pool - and
    // must finish before the connection pool goes. With syncClose a rejection
    // would skip the later steps and the exit, so it is logged, not thrown.
    syncClose: true,
    closePromises: [
      async () => {
        try {
          await fastify.close();
        } catch (error) {
          fastify.log.error(error);
        }
      },
      closeDbConnection,
    ],
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
