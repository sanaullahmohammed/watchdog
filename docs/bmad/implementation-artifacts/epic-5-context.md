# Epic 5 Context: Automated monitoring and uptime history

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Outages are detected rather than noticed. Synthetic checks run on a schedule inside the worker, results are stored append-only and rolled up into a public 90-day uptime history, and repeated failures propose a draft incident that a human confirms. The epic also makes incident timeline order independent of the clock (Epic 2's D-1) before monitors begin writing into drafts. It is delivered after Epic 9 and before Epic 4.

## Stories

- Story 5.1: Create and update a monitor
- Story 5.2: List a service's monitors
- Story 5.3: Keep check results in monthly partitions
- Story 5.4: HTTP and keyword checks behind the target guard
- Story 5.5: TCP and SSL-expiry checks
- Story 5.6: Record a check result and count consecutive failures
- Story 5.7: Warn once per certificate before it expires
- Story 5.8: Find and run the checks that are due
- Story 5.9: Run checks on the worker's own loop
- Story 5.10: Monitor state moves service status
- Story 5.11: Refresh daily uptime rollups
- Story 5.12: Fill the 90-day uptime in the public payload
- Story 5.13: Order the admin timeline by sequence, not the clock
- Story 5.14: Order the public timeline by the same sequence
- Story 5.15: Open a draft when a monitor breaches its threshold
- Story 5.16: Reconcile missed drafts each pass

## Requirements & Constraints

- Four monitor types: `http`, `tcp`, `keyword`, `ssl_expiry`. Invalid configs are refused with a 400 naming the field on both REST and GraphQL (the handler applies its schema itself). Timeout must be below interval; failure threshold at least 1; `ssl_expiry` needs a positive whole `config.warnDays`.
- No monitor delete in v1. `DeleteMonitorCommand`, `GetMonitorResultsQuery` and `monitor.deleted` are deferred; an operator disables a monitor instead. A disabled or never-checked monitor contributes nothing to status.
- Archiving a service suspends its monitors without destroying them; restoring resumes enabled ones. The due-monitor query joins `services` and filters archived ones out.
- Editing `enabled` or `failure_threshold` can move derived state: emit `monitor.state_changed`, never `monitor.threshold_breached`. Entering `failing` by edit or check increments `failure_episode`, which is never reset. Re-enabling resets `consecutive_failures` to 0 and `last_checked_at` to null.
- SSL checks measure availability: fail only when no certificate is retrievable or it is invalid (untrusted, hostname mismatch, expired, not yet valid). An expiring but valid certificate succeeds. Results carry fingerprint, expiry and whole days remaining (all null, never zero, when no certificate). The warning fires once per monitor per certificate fingerprint when expiry falls within `warnDays` (timestamp comparison), including for expired or untrusted-in-window certificates; none when no certificate was retrieved.
- Uptime rollups: UTC days, 3-level monitor-observed scale (`operational`, `degraded`, `major_outage`), computed only from `check_results`, never folding in incidents or maintenance. Days with no checks have no row; the public page states this explicitly. Each pass refreshes today and yesterday, and catches up closed days via per-organization progress before partition retention drops raw results. A day lost to retention is logged, not invented.
- One incident per monitor per failure episode, at most. A dismissed draft stays dismissed for its episode; the next episode may draft again.
- Raw results are retained per `CHECK_RESULTS_RETENTION_DAYS` (default 30) by dropping expired monthly partitions.

## Technical Decisions

- Monitor state is derived from stored rows only, never from events: `healthy` at 0 failures, `degraded` below threshold, `failing` at or above. Service `monitorState` is the worst contributing monitor, or null. The rule is a pure function in `src/shared/domain/monitor-state.ts`, used by both `monitoring` and `service`.
- Event contracts live in `src/shared/events/monitor.events.ts` with their own payload types; modules never import each other. Monitoring never writes `incidents`: the `incident` module handles `monitor.threshold_breached` and creates the draft (`source: monitoring`, `origin_monitor_id`, `origin_failure_episode`, impact `critical`). Events are one-shot, so the worker pass reconciles missed drafts; partial unique indexes make both paths idempotent and a unique violation means "already exists".
- Check execution flow: select due enabled monitors, run the check, then in one tenant transaction append the result, lock the monitor row (`for no key update`) and update counters and `failure_episode`; emit events after commit. The SSL warning marker (`monitor_ssl_warnings`, PK org, monitor, fingerprint) is written in the same transaction via `insert ... on conflict do nothing`; emit only if a row was created.
- Target safety (SSRF): the worker resolves the host and refuses loopback, private, unique-local, link-local (incl. `169.254.169.254`), unspecified and multicast addresses, applied to the address actually connected to and to each redirect hop. Allowed CIDRs come from `src/config` (empty by default). HTTP follows a small fixed number of redirects; keyword reads a capped body. A refused target is a failed check with an error code naming the refusal. Configure-time validation is a courtesy only.
- `check_results` is range-partitioned by month on `checked_at`, PK `(id, checked_at)`, tenant FKs `(monitor_id, org_id)` and `(service_id, org_id)`, RLS enabled and `FORCE`d, and `UPDATE`/`DELETE` revoked from `watchdog_app` in the migration.
- New tables with `org_id` need RLS enabled, forced, a policy comparing `org_id` to `current_setting('app.current_org_id', true)`, and must pass `tenant-rls-coverage.integration.test.ts`. Migrations already applied are never edited.
- `src/worker.ts` is a composition root, so a story may wire a module command into a worker pass (5.3, 5.9, 5.11, 5.16). Use `clock_timestamp()` where order under locks matters; D-1 (5.13/5.14) replaces clock ordering of `incident_updates` with a sequence column in both `incident` and `status-page` SQL.
- Conventions that bite here: command handlers call `assertMatchesSchema`/`assertUuid`; handlers never import `dtos/`; one shared presenter for REST and GraphQL; `.schema.ts` exports exactly one TypeBox request object; ordered queries end at a unique column (`id`); tenant reads/writes go through `withTenantTransaction`; configuration only through `src/config/`. Integration tests must not run an unscoped worker pass: pass `{ orgIds }` or run the per-organization command. Check-failure messages a client should read must be `ExceptionBase`.
- The foreign-table-read allowlist (Epic 3 retro item 23) is extended starting with 5.8 (due query joins `services`), then 5.10 and 5.12.

## Cross-Story Dependencies

- Stories run in order; each depends only on earlier ones. 5.1-5.7 build the module from configuration to a recorded result; 5.8-5.9 find and run due checks; 5.10 feeds monitor state into service status; 5.11-5.12 produce the public history; 5.13-5.14 (D-1) must land before 5.15 writes into drafts; 5.15-5.16 open and reconcile drafts.
- 5.1 introduces `monitor-state.ts`, `monitor.events.ts`, the `monitors` migration and the `createMonitor` fixture, which later stories reuse. 5.2 adds the id-taking `Query` field registry beside 9.11's mutation registry (closes a deferred-work entry). 5.9 closes three deferred-work entries targeting Epic 5; each story removes the entries it closes.
- 5.4's local test endpoints in `src/shared/testing/test-endpoints.ts` are reused by later suites.
- Touches other epics' modules through events only: `service` (status recompute on `monitor.state_changed`), `incident` (drafts), `status-page` (uptime in the public payload, timeline order).
