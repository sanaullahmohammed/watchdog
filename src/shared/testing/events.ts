import type { FastifyInstance } from 'fastify';

/**
 * Event capture for tests. Both helpers subscribe before `run` and never
 * remove the listener, as the per-suite copies did. Each call adds its own
 * permanent listener and its own array, so captures never mix between calls,
 * however many times a suite calls them for one event type.
 */

/** Runs `run` and returns its result with every event of `type` emitted, in order. */
export async function capturing<T>(
  app: FastifyInstance,
  type: string,
  run: () => Promise<T>,
) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

/** Runs `run` and returns its result with the type names seen, in emit order. */
export async function capturingTypes<T>(
  app: FastifyInstance,
  types: string[],
  run: () => Promise<T>,
) {
  const seen: string[] = [];
  for (const type of types) {
    app.eventBus.on(type, () => seen.push(type));
  }
  const result = await run();
  return { result, seen };
}
