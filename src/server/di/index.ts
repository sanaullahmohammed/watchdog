import path from 'node:path';
import { type Cradle, fastifyAwilixPlugin } from '@fastify/awilix';
import { asFunction, createContainer, Lifetime } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { makeDependencies } from '@/modules';
import { createSmtpEmailSender } from '@/modules/notification/infrastructure/smtp-email-sender';
import { formatName } from '@/server/di/util';

export async function di(fastify: FastifyInstance) {
  // One container per app, so its handlers bind to this app's buses and closing
  // the app disposes only its own container.
  const diContainer = createContainer<Cradle>({ injectionMode: 'PROXY' });
  diContainer
    .register({
      ...makeDependencies({
        logger: fastify.log,
        queryBus: fastify.queryBus,
        commandBus: fastify.commandBus,
        eventBus: fastify.eventBus,
      }),
      // Named explicitly: `smtp-email-sender.ts` matches none of the globs
      // below. One sender per app; it holds no connection between sends.
      emailSender: asFunction(() =>
        createSmtpEmailSender(env.email),
      ).singleton(),
    })
    .loadModules(
      [
        path.join(
          __dirname,
          '../../modules/**/*.{repository,mapper,service,domain}.{js,ts}',
        ),
      ],
      {
        formatName,
        resolverOptions: {
          register: asFunction,
          lifetime: Lifetime.SINGLETON,
        },
      },
    )
    .loadModules(
      [
        path.join(
          __dirname,
          '../../modules/**/*.{handler,event-handler}.{js,ts}',
        ),
      ],
      {
        formatName,
        resolverOptions: {
          asyncInit: 'init',
          register: asFunction,
          lifetime: Lifetime.SINGLETON,
        },
      },
    );

  // Create a dependency injection container
  await fastify.register(fastifyAwilixPlugin, {
    container: diContainer,
    asyncInit: true,
  });
}
