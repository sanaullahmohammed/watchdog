---
title: 'Epic 9 retro item 8 — consolidate deferred-work.md'
type: 'chore'
created: '2026-10-09'
status: 'done'
baseline_commit: '7618df96008a51c6d4149e99837129146d560474'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `deferred-work.md` has 47 entries. Six groups are duplicates of one defect each (retro "Deferred-work audit"). One entry is a status note, not work. One names helpers that no longer exist. Several point at "the entry above", and no entry says when it should be picked up (retro action item 8).

**Approach:** Rewrite the file in place.
- Merge each duplicate group into one entry that lists every source spec.
- Drop the 9.4 status note, and fix the stale `input.ts` evidence.
- Add the retro's DR-5 `cause` evidence to the redaction entry.
- Replace positional cross-references with named ones.
- End every entry with a `target:` line naming its epic or trigger.

The retro's malformed-id merge, its `maintenanceWindow` addition and its "#10 confirmed" edit are moot, because items 1–3 removed those entries. The clock-skew entry stays until item 7 lands. No entry's substance is lost, and no new work is added.

</frozen-after-approval>

## Implementation Notes

**Counts.** The retro audited 44 entries at `ca74075`. Items 1–3 then removed five (#6, #16, #33, #10, #25), and items 1a, 1c, 2 and 4 added eight, so there were 47 before this change and 37 after it. The ten removals: three by the `urn:uuid:` merge (four entries into one), two by the dates merge (three into one), one each by the whitespace, null-coercion, `input.ts` bullet and Postgres error-field merges, and one by dropping #19. The retro's seventh duplicate group (malformed id on reads, #6/#16) no longer exists, because item 1 removed both. Every entry has one `target:` line (`grep -c '^- source_spec'` and `grep -c '^  target:'` both give 37).

**Old numbers.** The retro and `sprint-status.yaml` cite entries by their number at `ca74075`. In the new file:
- #3, #23, #26 and the retro 1a `urn:uuid:` entry are the 9.1 `urn:uuid:` entry.
- #12, #15 and #21 are the 9.3 date-range entry.
- #4 and #13 are the 9.1 whitespace entry.
- #5 and #18 are the 9.1 null-coercion entry.
- #7 and #20 are the 9.1 `input.ts` bullet entry.
- #38 and #41 are the first 9.13 entry. #39 is the second, and #40 the third.
- #17 is the 9.3 clock-skew entry. It stays until item 7 lands, and item 7's action text still calls it "deferred #17".
- #19 was dropped. #6, #10, #16, #25 and #33 were removed by items 1–3.
- Every other entry keeps its text under its story heading.

**Choices.**
- Entries no source places earlier are tagged "Epic 8 (default)", where Epic 8 is release readiness.
- Edits to AGENTS.md are tagged as dev-loop housekeeping, and genesis edits as the owner's. Neither is attached to item 7, which would widen it.
- The retro's DR-5 `cause` evidence went into the second 9.13 entry. Its summary already named the path.
- The date entry's cause was corrected. Year 0000 and the offset case fail in Postgres with different errors, which were reproduced. Body ids were added to the `urn:uuid:` entry.
- `sprint-status.yaml` is left for the item-8 done-flip after merge, as items 1–4 were.

## Review Triage Log

| # | Finding (blind) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The merged date entry gives one Postgres error for both cases, and the wrong cause for the offset case | medium | Reproduced: year 0000 fails with "date/time field value out of range", and `+010000-…` with "time zone displacement out of range". | patch |
| 2 | The `urn:uuid:` entry says "every id check" but omits ids inside request bodies | medium | `format: 'uuid'` sits on `affectedServices[].serviceId`, `serviceGroupId` and the maintenance service ids. | patch |
| 3 | The uuid entry and the letter-case duplicate-id entry are not linked | low | Both concern canonical uuids. A cross-reference is direct. | patch |
| 4 | The 9.9 entry cites the stale `ARCHITECTURE.md:782` | low | The sentence is now at `:786`. It is cited by section instead. | patch |
| 5 | Old `#N` numbers no longer map to entries | low | The retro and sprint-status cite them. Mapped in Implementation Notes. | patch |
| 6 | "With action item 7" widened item 7 to genesis edits | medium | Item 7 is one AGENTS.md pitfall, and genesis edits belong to the owner. Retagged as AGENTS.md or genesis edits. | patch |
| 7 | The legend's genesis rule conflicts with the `Retry-After` entry's Epic 4 target | low | The legend now says an edit that belongs to a code change goes with that change. | patch |
| 8 | Some `target:` lines carry two targets or commentary | low | The commentary moved to `evidence:`. | patch |
| 9 | The two 9.13 redaction entries do not name each other | low | The retro calls them overlapping. Cross-referenced. | patch |
| 10 | `source_spec` is formatted inconsistently | low | Normalized to backticks everywhere. | patch |
| 11 | The spec has no counts and no check | low | Counts and the grep are recorded above. | patch |
| 12 | The spec does not explain 47 against the retro's 44 | low | Explained under Counts. | patch |
| 13 | `sprint-status.yaml` is not updated | low | Item 8 is flipped after merge, as items 1–4 were. | reject |
| 14 | The header copies the epic delivery order from its owner | low | It now cites ROADMAP section 2 instead. | patch |
