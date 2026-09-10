import { startApi } from '@/api';
import { startWorker } from '@/worker';

/**
 * One image, two entrypoints. Runtime behaviour is selected by command so the
 * dependency graph, configuration and migrations stay identical across both.
 * See ARCHITECTURE.md section 4.
 */
const ENTRYPOINTS = {
  api: startApi,
  worker: startWorker,
} as const;

type Entrypoint = keyof typeof ENTRYPOINTS;

function resolveEntrypoint(argv: string[]): Entrypoint {
  const requested = argv[2] ?? 'api';

  if (!(requested in ENTRYPOINTS)) {
    const valid = Object.keys(ENTRYPOINTS).join(', ');
    console.error(
      `Unknown entrypoint "${requested}". Expected one of: ${valid}`,
    );
    process.exit(1);
  }

  return requested as Entrypoint;
}

ENTRYPOINTS[resolveEntrypoint(process.argv)]();
