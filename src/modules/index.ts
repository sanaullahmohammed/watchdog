import { asValue } from 'awilix';
import type { FastifyBaseLogger } from 'fastify';
import type { CommandBus, EventBus } from '@/shared/cqrs/bus.types';

declare global {
  export interface Dependencies {
    logger: FastifyBaseLogger;
    queryBus: CommandBus;
    commandBus: CommandBus;
    eventBus: EventBus;
  }
}

/**
 * The values every module can depend on.
 *
 * There is deliberately no shared database handle or generic repository here.
 * Tenant data is reached only through `withTenantTransaction`, and the
 * boilerplate's global-connection repository base, removed with its demo
 * `user` module, would have seen nothing under RLS.
 */
export function makeDependencies({
  logger,
  queryBus,
  commandBus,
  eventBus,
}: {
  logger: FastifyBaseLogger;
  queryBus: CommandBus;
  commandBus: CommandBus;
  eventBus: EventBus;
}) {
  return {
    logger: asValue(logger),
    queryBus: asValue(queryBus),
    commandBus: asValue(commandBus),
    eventBus: asValue(eventBus),
  };
}
