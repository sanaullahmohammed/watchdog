import { buildApp as build } from '@/server/build-app';

// Cucumber's entry point into the same instance the api entrypoint builds.
export const buildApp = () =>
  build({ logger: { level: 'warn' }, disableRequestLogging: true });
