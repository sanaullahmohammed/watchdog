import pino from 'pino';
import postgres from 'postgres';
import { env } from '@/config';
import { LOG_REDACT_PATHS, sqlDebugOption } from '@/shared/db/sql-debug';

const sql = postgres(env.db.url, {
  ...sqlDebugOption(env.log.level, () =>
    pino({ level: env.log.level, redact: LOG_REDACT_PATHS }),
  ),
});

export async function closeDbConnection() {
  await sql.end({ timeout: 5 });
}

export default sql;
