import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { roleRefusal } from '@/shared/db/runtime-role';

/** Epic 3 retrospective, action item 10 (R-14): the rule the boot guard applies. */

const role = (rolsuper: boolean, rolbypassrls: boolean) => ({
  rolname: 'someone',
  rolsuper,
  rolbypassrls,
});

describe('roleRefusal', () => {
  it('lets a role bound by RLS run the application', () => {
    assert.equal(roleRefusal(role(false, false)), undefined);
  });

  it('refuses a superuser, a BYPASSRLS role, and one that is both, saying why', () => {
    assert.match(
      roleRefusal(role(true, false)) ?? '',
      /^DATABASE_URL connects as "someone", which is a superuser, so row-level security would not apply/,
    );
    assert.match(
      roleRefusal(role(false, true)) ?? '',
      /^DATABASE_URL connects as "someone", which has BYPASSRLS, so/,
    );
    assert.match(
      roleRefusal(role(true, true)) ?? '',
      /which is a superuser and has BYPASSRLS, so/,
    );
  });

  it('names the fix', () => {
    assert.match(
      roleRefusal(role(true, false)) ?? '',
      /Point DATABASE_URL at the application role, watchdog_app\.$/,
    );
  });
});
