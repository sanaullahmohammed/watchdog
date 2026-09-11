-- migrate:up
-- The boilerplate's demo `users` table, removed with the `user` and
-- `settings` modules that were its only writers. Identity belongs to Better
-- Auth's `"user"` table, which this does not touch.
--
-- Its `delete-user` endpoint required no authentication on REST or GraphQL,
-- and blocked Epic 2's acceptance (retrospective R-1,
-- docs/bmad/implementation-artifacts/epic-2-retro-2026-09-11.md).
drop table if exists "users";

-- migrate:down
-- Recreates the table exactly as 20240415225644_create_users_table.sql did.
-- The rows are not restored; they were demo data.
create table "users" (
  "id" character varying not null,
  "createdAt" timestamp with time zone not null default now(),
  "updatedAt" timestamp with time zone not null default now(),
  "email" character varying not null,
  "country" character varying not null,
  "postalCode" character varying not null,
  "street" character varying not null,
  "role" character varying not null,
  constraint "UQ_e12875dfb3b1d92d7d7c5377e22" unique ("email"),
  constraint "PK_cace4a159ff9f2512dd42373760" primary key ("id")
);
