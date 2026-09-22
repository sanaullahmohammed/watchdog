import envSchema from 'env-schema';
import { type Static, Type } from 'typebox';

/**
 * The owner connection DBMate migrates with, `DBMATE_DATABASE_URL`. In
 * Compose and in CI that role is the Postgres superuser.
 *
 * The application never connects with it, and no application module may
 * import this. It exists so a test can prove what the boot guard does when
 * the two URLs are swapped: `api` and `worker` must refuse to start. Read
 * through env-schema like the rest of configuration, so `.env` supplies it
 * locally and CI declares it, and required, so a run without it fails rather
 * than skipping the proof.
 */
const schema = Type.Object({ DBMATE_DATABASE_URL: Type.String() });

export function ownerDatabaseUrl(): string {
  return envSchema<Static<typeof schema>>({ dotenv: true, schema })
    .DBMATE_DATABASE_URL;
}
