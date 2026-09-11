import postgres from 'postgres';
import { env } from '@/config';
import { LogLevel } from '@/config/env';

const sql = postgres(env.db.url, {
  debug: (
    conn: number,
    query: string,
    params: unknown[],
    paramTypes: unknown[],
  ) => {
    if (env.log.level === LogLevel.debug) {
      console.debug(`
    SQL::
      Executing query: "${query.trim()}"
      Params: ${JSON.stringify(params)}
      Param Types: ${JSON.stringify(paramTypes)}
      Connection: ${conn}
    `);
    }
  },
});

export async function closeDbConnection() {
  await sql.end({ timeout: 5 });
}

export default sql;
