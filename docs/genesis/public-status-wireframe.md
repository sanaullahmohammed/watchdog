# Public status page — throwaway wireframe

**Story 3.1. This is a constraint, not a frontend.**

v1 ships no UI. The beneficiary of `/status/:orgSlug` is an integrator, not a
browser. But a payload designed against nothing tends to be shaped like the
tables behind it, and then the first real renderer discovers it cannot say
"Degraded since 14:02" without three more requests. So this sketch exists to be
argued with and then left alone: no framework, no component library, no CSS,
nothing anyone is expected to build on. It is kept as the record of what the
payload was designed against, and struck through if it ever stops matching.

## The sketch

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Acme Cloud                                            status page   │
│                                                                      │
│  ●  Partial outage                            checked 15:04 UTC      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ACTIVE INCIDENT                                                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Elevated error rates on the Public API          major · 40m     │  │
│  │ identified                                                      │  │
│  │                                                                 │  │
│  │ 14:41  The cause is a misconfigured connection pool in the      │  │
│  │        latest API deploy. A rollback is in progress.            │  │
│  │ 14:24  We are investigating elevated 5xx responses.             │  │
│  │                                                                 │  │
│  │ Affects: Public API, Webhooks                                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  SCHEDULED MAINTENANCE                                               │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Primary database version upgrade              18 Sep 02:00 UTC  │  │
│  │ scheduled · 2h          Affects: Primary database, Public API   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  CORE PLATFORM                                                       │
│    Public API            ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄░░░░  partial outage     │
│    Web dashboard         ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  operational        │
│    Authentication        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  operational        │
│                                                                      │
│  DATA                                                                │
│    Primary database      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  operational        │
│    Object storage        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  operational        │
│                                                                      │
│  INTEGRATIONS                                                        │
│    Webhooks              ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄░░░  degraded           │
│    Email delivery        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  operational        │
│                                                                      │
│                                          ← 90 days      today →      │
└──────────────────────────────────────────────────────────────────────┘
```

## Every element, and the field it needs

| On the sketch | Payload field | Source |
|---|---|---|
| "Acme Cloud" | `organization.name`, `organization.slug` | Better Auth `organization`, read on the pre-tenant path (story 3.2) |
| "Partial outage" banner | `overallStatus` | Worst-of the public services' statuses, by DOMAIN's `SERVICE_STATUS_RANK` |
| "checked 15:04 UTC" | `generatedAt` | When the payload was composed. A poller needs it; a cache needs it |
| Group headings, and their order | `groups[].name`, `groups[].displayOrder` | `service_groups` |
| Service name and status | `groups[].services[].name`, `.status` | `services.last_known_status`, never recomputed per request |
| Service ordering within a group | `groups[].services[].displayOrder` | `services.display_order`, then name |
| Services in no group | `groups[]` entry with a null id | `services.service_group_id is null` |
| Incident title, impact, status | `activeIncidents[].title`, `.impact`, `.status` | `incidents` |
| "40m" | derived from `activeIncidents[].startedAt` | `incidents.started_at` |
| The two timestamped update lines | `activeIncidents[].updates[]` (`status`, `message`, `createdAt`) | `incident_updates`, oldest to newest; the renderer reverses |
| "Affects: Public API, Webhooks" | `activeIncidents[].affectedServiceIds` | `incident_service_impacts` |
| Window title, time, duration | `maintenance[].title`, `.scheduledStartAt`, `.scheduledEndAt` | `maintenance` |
| Window status (`scheduled` / `in_progress`) | `maintenance[].status` | `maintenance` |
| "Affects: Primary database, Public API" | `maintenance[].affectedServiceIds` | `maintenance_services` |
| The 90-day bars | `uptime` | Shaped now, empty until Epic 5's rollups (decision recorded in the epic) |

Nothing on the sketch is left without a field, so nothing is struck out.

## What the shape can and cannot say

**Grouping and ordering are representable.** Services arrive nested in their
groups, each carrying `displayOrder`, and the groups carry theirs. A renderer
sorts nothing and invents nothing.

**"Degraded since 14:02" is only half representable, and that is worth knowing
now.** For a service degraded by an incident or a maintenance window, the
"since" is `activeIncidents[].startedAt` or `maintenance[].startedAt`, both in
the payload. For a service degraded by a manual override or, from Epic 5, by
monitor state, there is no such timestamp anywhere: `last_known_status` is
written by the recomputation handler, which deliberately leaves `updated_at`
alone so it still records human edits. So the sketch's per-service "since" is
**out of scope for v1**, and the cheapest fix when it is wanted is a
`status_changed_at` column written by that same handler when, and only when,
the status actually moves. It is one column and one line, and it is not being
added speculatively.

**The 90-day bars are shape only.** The field exists, carries its window length,
and is explicitly empty until rollups arrive. An integrator can tell "no data
yet" from "100% uptime", and nothing about the contract changes in Epic 5.

## Deliberately not on the page

- **Live updates.** The page is a fetch. SSE is Epic 4, on `/status/:orgSlug/events`.
- **Subscribe by email, and the RSS feed.** Epic 6.
- **Incident history and per-incident pages.** v1 shows what is happening, not
  an archive. Resolved incidents leave the page.
- **Any styling decision.** Colour, dark mode, density and iconography are a
  renderer's business, and this file has no opinion worth inheriting.

## What this settles for story 3.3

The payload is one document with seven top-level keys: `organization`,
`overallStatus`, `generatedAt`, `groups`, `activeIncidents`, `maintenance` and
`uptime`. Two of those exist only because the sketch asked for them:
`overallStatus`, so every renderer reduces the ladder the same way rather than
each inventing a banner, and `generatedAt`, so a poller can tell one answer
from the next.
