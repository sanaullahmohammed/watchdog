import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import sql from '@/shared/db/postgres';
import { registerNotifyBridge } from '@/shared/realtime/notify-bridge';
import fastifyCqrs from '../../shared/cqrs';

async function cqrsPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyCqrs);
  // Here rather than in src/shared/cqrs, which stays free of the global
  // connection. Every app instance loads this plugin, so the api, the worker
  // and every test app all bridge (story 4.3).
  registerNotifyBridge(fastify.eventBus, sql);
}

export default fp(cqrsPlugin, {
  name: 'CQRSPlugin',
});
