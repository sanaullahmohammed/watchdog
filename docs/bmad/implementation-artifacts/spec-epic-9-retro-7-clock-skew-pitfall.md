---
title: 'Epic 9 retro item 7 — record the clock-skew rerun rule in AGENTS.md'
type: 'chore'
created: '2026-10-09'
status: 'done'
baseline_commit: '196c7fd057c8911c003a1d1be209e7430737cd2a'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The development VM's clock steps backwards inside WSL2 and Docker, so integration tests that order rows by time fail now and then. On 2026-10-08 the owner decided not to fix the clock: a failing integration test is rerun a few times, and a failure that repeats is treated as real (retro P2, action item 7). That rule lives only in an assistant memory, so another agent or person would not know it. `deferred-work.md` still carries the 9.3 clock-skew entry the decision settles.

**Approach:** Add one Known pitfalls bullet to AGENTS.md. It says what happens, what the owner decided, and how to tell a flake from a defect. Remove the 9.3 clock-skew entry from `deferred-work.md`, which this closes. The timeline sequence column (retro D-1) is a separate Epic 5 item and stays out.

</frozen-after-approval>

## Implementation Notes

- AGENTS.md gains one Known pitfalls bullet, after the `now()`/`clock_timestamp()` one. It covers:
  - the symptom, and how to confirm it with `journalctl`;
  - that `clock_timestamp()` is not monotonic on that machine;
  - D-1 as the lasting fix for timelines;
  - the owner's rule: rerun two or three times, alone and in the full suite, a repeat is real, report the first failure and the reruns;
  - that CI is exempt.
- `deferred-work.md` loses the 9.3 clock-skew entry, which the retro and the item 8 spec call "deferred #17". There are 36 entries now.
- The assistant memory rule that held this rule was retired, so only one copy remains.

## Review Triage Log

| # | Finding (blind) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The bullet dropped half the rule: run alone and in the full suite, report the reruns, never drop a failure silently | medium | The memory rule it replaces said all three. | patch |
| 2 | "A few times" is vague | low | Now "two or three times". | patch |
| 3 | It does not say CI is exempt | medium | CI is not WSL2; a CI failure must not be rerun away. | patch |
| 4 | "Any failure not about time order" contradicts the owner's "rerun any failing test" | low | The clause is removed, and the retro's wording is used. | patch |
| 5 | Nothing says how to recognise the flake | low | The symptom and `journalctl` confirmation were added. | patch |
| 6 | It conflicts with the `clock_timestamp()` pitfall above it, with no pointer to the lasting fix | low | It now says `clock_timestamp()` is not monotonic there, and names D-1. | patch |
| 7 | Removing the entry cuts the link between the skew and D-1 | low | AGENTS.md now names D-1. | patch |
| 8 | "Several times a minute" overstates the measurement | low | 4 steps in 120 s; now "about twice a minute". | patch |
| 9 | The prose is awkward, and the decision line is unlike the other pitfalls | low | Reworded. The decision is cited as "Epic 9 retrospective, P2". | patch |
| 10 | The spec is unfinished | low | Notes and this log were added. | patch |
| 11 | The memory rule and the item 8 spec's "#17" note go stale | low | The memory was retired. The item 8 spec is a record of its time; this spec says where #17 went. | patch / reject |

