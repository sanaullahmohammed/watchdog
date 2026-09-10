#!/usr/bin/env node
/**
 * Drift check between Better Auth's expected schema and the committed DBMate
 * migrations.
 *
 * `auth generate` introspects the live database and emits DDL for whatever is
 * missing. Run against a fully migrated database it emits nothing and reports
 * "Your schema is already up to date". So: a non-empty output file means the
 * committed migrations no longer satisfy Better Auth, which happens when the
 * package is upgraded, a plugin is added, or `schema.*.modelName` is changed.
 *
 * The fix is never to edit an applied migration. Write a new one for the
 * emitted DDL, refresh db/better-auth-schema.sql, and re-run this check.
 *
 * Requires DATABASE_URL to point at a database that `dbmate up` has been run
 * against.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG = 'src/server/auth/auth.ts';
const BASELINE = 'db/better-auth-schema.sql';

// Resolved explicitly rather than relying on PATH, so the script behaves the
// same under `pnpm run`, a bare `node scripts/...`, and a CI step.
const CLI = join(process.cwd(), 'node_modules', '.bin', 'auth');

// No env precondition here on purpose: auth.ts resolves its config through
// src/config/env.ts, which merges process.env over `.env` and fails with a
// schema error naming the missing variable. Locally `.env` is enough; in CI
// the real environment variables are.

const dir = mkdtempSync(join(tmpdir(), 'watchdog-auth-schema-'));
const out = join(dir, 'regen.sql');

try {
  if (!existsSync(CLI)) {
    console.error(`Better Auth CLI not found at ${CLI}. Run \`pnpm install\`.`);
    process.exit(2);
  }

  const result = spawnSync(
    CLI,
    ['generate', '--config', CONFIG, '--output', out, '--yes'],
    { encoding: 'utf8', env: process.env },
  );

  if (result.error) {
    console.error('Failed to run the Better Auth CLI:', result.error.message);
    process.exit(2);
  }

  const cliOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.status !== 0) {
    console.error(
      `The Better Auth CLI exited ${result.status}. Output:\n\n${cliOutput}`,
    );
    process.exit(2);
  }

  const emitted = existsSync(out) ? readFileSync(out, 'utf8').trim() : '';

  if (emitted === '') {
    // An absent or empty file is only good news when the CLI actually said the
    // schema was satisfied. Otherwise it means the CLI never got far enough to
    // compare - an unreachable database, for instance - and reporting that as
    // "in sync" would make this check fail open.
    if (!/already up to date/i.test(cliOutput)) {
      console.error(
        [
          '',
          'The Better Auth CLI emitted no schema and did not report the schema',
          'as up to date, so nothing was actually verified. This usually means',
          'it could not reach the database named by DATABASE_URL.',
          '',
          cliOutput,
        ].join('\n'),
      );
      process.exit(2);
    }

    console.log(
      `Better Auth schema is in sync with the committed migrations (${BASELINE}).`,
    );
    process.exit(0);
  }

  console.error(
    [
      '',
      'Better Auth schema drift detected.',
      '',
      'The committed migrations no longer satisfy the schema Better Auth expects.',
      'It wants the following DDL, which no migration provides:',
      '',
      emitted,
      '',
      'To resolve:',
      '  1. pnpm run db:create-migration <name>',
      '  2. paste the DDL above into the new migration',
      `  3. regenerate ${BASELINE} against a clean database`,
      '  4. re-run this check',
      '',
    ].join('\n'),
  );
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
