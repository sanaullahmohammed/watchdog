import { authPool } from '@/server/auth/auth';
import { buildApp } from '@/server/build-app';
import { closeDbConnection } from '@/shared/db/postgres';

// Builds an app, closes it and closes postgres.js, and does nothing else: no
// process.exit. The process must end on its own.
async function main() {
  const app = await buildApp({ logger: false });
  await app.ready();
  // Opens a pooled connection, as a served request would; an unreleased pool
  // would then hold the process for pg's 10 s idle timeout.
  await authPool.query('select 1');
  await app.close();
  await closeDbConnection();
  // The test times the exit from this line, not tsx startup or the build.
  console.log('closed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
