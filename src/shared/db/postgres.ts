import pino from 'pino';
import postgres from 'postgres';
import { env } from '@/config';
import { scrubbedLoggerOptions, sqlDebugOption } from '@/shared/db/sql-debug';

const sql = postgres(env.db.url, {
  ...sqlDebugOption(env.log.level, () =>
    pino(scrubbedLoggerOptions(env.log.level)),
  ),
});

export async function closeDbConnection() {
  await sql.end({ timeout: 5 });
}

export default sql;
