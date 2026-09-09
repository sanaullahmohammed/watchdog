import Fastify from 'fastify';
import server from '../../src/server';

export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: 'warn',
    },
    disableRequestLogging: true,
    ignoreDuplicateSlashes: true,
    ajv: {
      customOptions: {
        keywords: ['example'],
      },
    },
  });

  await server(app);
  return app;
};
