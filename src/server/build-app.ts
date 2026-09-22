import { randomUUID } from 'node:crypto';
import { maxHeaderSize } from 'node:http';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { env } from '@/config';
import server from '@/server';

/**
 * Builds a fully configured Fastify instance without listening.
 *
 * Shared by the `api` entrypoint and by tests so that both exercise the same
 * plugin graph. A test that builds its own Fastify would silently diverge from
 * production as plugins are added.
 */
export async function buildApp(
  overrides: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.log.level,
      redact: ['headers.authorization'],
    },
    genReqId: (req) => {
      // header best practice: don't use "x-" https://www.rfc-editor.org/info/rfc6648 and keep it lowercase
      return (req.headers['request-id'] as string) ?? randomUUID();
    },
    routerOptions: {
      ignoreDuplicateSlashes: true,
      // The router's own 404 for a param over this length echoes the path,
      // and it answered every public slug longer than the default 100 before
      // the handler could (Epic 3 retrospective, R-8). No request line can
      // exceed Node's header limit, so at this length the router never answers
      // a single-segment /status path first; the handler does. The limit
      // exists to bound regex params, and no route declares one.
      maxParamLength: maxHeaderSize,
    },
    ajv: {
      customOptions: {
        keywords: ['example'],
      },
    },
    ...overrides,
  });

  await server(app);

  return app;
}
