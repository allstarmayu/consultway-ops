# Consultway Ops - Day 7 Report

**Date:** May 22, 2026
**Author:** Mayur (with Claude as engineering partner)
**Branch:** `dev`
**Commits:** 4 new commits on top of Day 6's foundation

---

## Executive summary

Day 7 turned `listAuditEvents` (shipped Day 6) into three visible UI
surfaces and one polish layer. A "Recent activity" card lives on the
dashboard home page, "History" cards live on the tender and company
detail pages, and every row across all three surfaces is now
click-to-expand with a field-by-field diff panel showing exactly what
changed in a mutation.

Four commits shipped to `dev`. Each is independently `tsc`-clean and
independently smoke-tested. The audit infrastructure that has been
quietly accumulating for six days finally surfaced to the user, and
the design choice to capture `before` / `after` snapshots on every
write (made on Day 2) paid off: the diff panel rendered out-of-the-box
with no data-model changes.

One thread from the original Day-7 plan was dropped before any code
was written: the prompt asked for swapping `scripts/snapshot.ps1` to
`repomix`, but the PowerShell script was already retired on Day 6 and
replaced with `scripts/snapshot.ts` (a TypeScript generator). The
Day-6 report explicitly chose the TS generator over `repomix`, so
re-rolling that decision in Day 7 would have meant throwing out
working same-week tooling. Skipped on agreement.

Two PowerShell-quirk side-discoveries landed alongside the planned
work and are written up below: the `-LiteralPath` parameter on
`Copy-Item` silently no-ops when the source argument is positional,
and browser-cache de-duplication can serve an old downloaded file
under the same filename without warning. Both cost time during the
chunk-3 land. Both have written-down workarounds now.

---

## What works today

### Recent-activity widget on `/dashboard`

- New `<ActivityFeed>` Server Component on the dashboard home page,
  rendering up to 20 most-recent audit events with iconography per
  verb, role-scoped visibility, and resolved entity names instead of
  raw UUIDs.
- Wrapped in `<Suspense>` so the welcome card streams immediately and
  the activity card streams in when its DB queries resolve. Skeleton
  fallback matches the populated-card geometry so the viewport
  doesn't jump.
- Three render states handled: error (Alert), empty (shared
  `<ActivityFeedEmpty>` clock-icon empty state), populated (vertical
  `<ul>` of rows).
- Each row is a coloured icon disc + sentence + relative timestamp.
  Icon and tone come from `lib/audit/labels.ts` which exhaustively
  maps every `AuditAction` to `{ verb, icon, tone }`. Adding a new
  verb to the union without a label is a TypeScript error.
- Reversal verbs (Day-5's four) render with the Terracotta accent
  tone, distinct from create / update / delete. Reversal reasons
  from `metadata.reason` surface as an italic suffix under the
  sentence.

### Per-entity History sections

- New `<EntityHistory>` Server Component on `/dashboard/tenders/[id]`
  and `/dashboard/companies/[id]`. Same row component as the
  dashboard widget; same iconography and tone treatment.
- Company variant: single `listAuditEvents` call filtered to
  `targetType: 'company'` + the specific id. Newest-first, 50-row
  cap.
- Tender variant: two `listAuditEvents` calls. One filtered to the
  tender itself, one to all recent `tender_application` events
  globally then post-filtered in JS by `metadata.tenderId`. The two
  result sets are merged and sorted by `createdAt DESC` before
  truncation. This is what lets a tender's History show the full
  lifecycle: created, published, applied (multiple), shortlisted,
  withdrawn, retracted, etc., all in one feed.
- Same Suspense + skeleton + empty-state shell as the dashboard
  widget.

### Click-to-expand diff panel

- `<ActivityFeedRow>` promoted to Client Component for the toggle
  state. Default collapsed - the feed stays scannable.
- Each row gets a small `· › details` link to the right of the
  timestamp when the event has a meaningful `before`/`after` diff.
  Click reveals an indented muted panel listing each changed field
  as "Field name: old value -> new value".
- Pure `computeDiff` helper in `lib/audit/diff.ts` does the work:
  walks both snapshots, skips `createdAt`/`updatedAt` noise, skips
  fields whose before === after, sorts alphabetically by field name
  for stable render order.
- Booleans render as Yes/No. Nulls and missing values render as a
  muted em-dash. Empty strings render as "(empty)". Long strings
  (>80 chars) truncate with an ellipsis and the full string is
  available on hover via `title`.
- Works on dashboard widget AND per-entity History sections without
  changing them - they share the row component.

### Batched id-to-name resolver

- New `resolveReferences` helper in `lib/audit/resolve-targets.ts`.
  Issues at most 4 batched IN-queries (one per entity type) plus an
  optional 2-query secondary fan-out for applications. For a 20-row
  feed hitting 3 target types + 1 actor lookup, that's typically 4
  queries total.
- Resolved names are always fresh - a company rename propagates to
  the feed on next render. The alternative (capture name in
  `metadata.targetName` at write time) was rejected because of
  staleness.
- Dangling targets (audit rows pointing at hard-deleted entities)
  render as italic "Deleted item" in the row sentence with no link.
  No-FK design from Day 6 means dangling pointers are expected;
  this is how the read side handles them.
- Application rows render as "{companyName}'s application to
  {tenderTitle}" via a secondary lookup. Falls back gracefully when
  only one half resolves.

### Defensive narrowing of audit verbs

- The `audit_log.action` column is plain TEXT in D1, so Drizzle
  infers it as `string` - not the narrow `AuditAction` union the
  rest of the codebase expects. The row component now narrows
  defensively via a `KNOWN_ACTIONS` set: known verbs go through
  `getAuditLabel`, unknown verbs (stale code retired in an earlier
  release, or a future verb whose label hasn't been wired) get a
  neutral HelpCircle fallback so the row stays readable instead of
  crashing the feed.
- Same defensive pattern in `resolve-targets.ts` for `targetType`.

---

## What's intentionally deferred

| Item | Why deferred |
| --- | --- |
| Cross-actor visibility widening | Phase 1B. Today, company-role users see their own actions plus their application events but not staff-actor events on their company or on tenders they applied to. Real value, real work; needs to be tackled as one deliberate session that decides exactly which staff events should reach applicants. The Day-6 report flagged this as Phase 1B; today's report confirms the gap is felt but still deferred. |
| Pagination on activity feeds | Out of scope. Initial 20-row cap on dashboard, 50-row cap on per-entity, both fine at Phase 1 scale. "Show older" is a Day-7+ polish item. |
| Filter chips on the activity feed | "Reversals only", "My team only", verb-filter, actor-filter. One step beyond MVP. Deferred. |
| Real-time updates | Polling / websockets / SSE. Out of scope for Phase 1. The feed is fresh-on-render which is good enough for the operational rhythm. |
| `/dashboard/audit` admin search page | Deferred until there's a real "we need to investigate something" use case. The per-entity History sections cover the common forensic ask. |
| Dedicated `listAuditEventsForTender` helper | The tender-history applications fan-out currently fetches the 200-row global cap of `tender_application` events and filters in JS. Fine at Phase 1 scale (single-digit-thousand events expected). When `audit_log` grows past ~10k rows the cap becomes a correctness concern. Replace with a dedicated helper that joins on `tender_applications.tenderId` server-side at that point. |
| Per-verb richer copy | `compliance_status_changed` could read "changed compliance to Compliant for Acme Construction" via `metadata.newStatus`. Verb-specific renderers, half a day each. Phase 1B polish. |
| Acronym-aware field-name humanisation | Current `humaniseFieldName` does dumb camelCase splitting - "isMsme" renders as "Is msme" instead of "Is MSME", same for "JV", "GST", "PAN". Cosmetic. Curated word list is the fix. |
| repomix tooling swap | Skipped on agreement. `scripts/snapshot.ts` (Day 6) already solves the bug the Day-7 prompt referenced. |

---

## Key decisions

**Card section, not tabs, for per-entity History.** The Day-7 prompt
flagged "one tab or two?" as an open question for the tender variant.
The answer turned out to be "neither" - tenders don't have tabs
today, and adding a tabs primitive is a layout-level decision that
needs Figma alignment. A History card below the Applications card
matches the existing pattern and works on day one.

**One combined feed on the tender History, not two widgets.** Same
question, different facet. The tender's own events and its
applications' events go into one merged-and-sorted list. Two separate
widgets reads as indecision; one combined view matches what someone
investigating a tender's history actually wants.

**Hybrid id-to-name resolution.** Four options were considered for
turning UUIDs into "Acme Construction Pvt Ltd": (a) join inside
`listAuditEvents`, (b) N+1 lookups, (c) render UUID + link, (d)
capture name in metadata at write time. Picked a fifth option: a
separate `resolveReferences` helper that does batched IN-queries
per entity type. Fresh names, no API pollution, no N+1, dangling
targets handled gracefully. The cost is an extra module; the
benefit is `listAuditEvents` stays single-purpose for other future
consumers.

**Skipped fields in the diff panel.** `createdAt` and `updatedAt`
always change on any mutation and add no signal - hard-coded skip.
Same-value fields filtered out (defensive against full snapshots
even though Day-2's design said snapshots should be partial). The
goal of the diff panel is forensic visibility, not raw data dump.

**Long strings truncated at 80 chars in the diff panel.** Internal
notes and descriptions can be paragraphs. Inline-rendering them
breaks the feed. Truncate with ellipsis, full text in `title`
attribute for hover-reveal. The 80-char threshold is empirical -
fits one comfortable line at the diff-panel font size.

**Client-Component conversion for the row.** The expand toggle
needs `useState`, so the row component is now `"use client"`. The
parent feed and history components stay Server. This keeps DB
access on the server (where it belongs) and only ships the toggle
JS to the client. The row is a leaf with no DB dependencies, so
the boundary is cheap.

**Defensive type narrowing on the DB string columns.** The schema's
`action` and `target_type` columns are plain TEXT because SQLite
has no enums. Drizzle infers them as `string`. The renderers cast
narrowly with a known-set check and a neutral-fallback path. Defence
in depth: the writer validates against the Zod union, the reader
tolerates anything that slips through.

---

## What went sideways - and what we learned

### `Copy-Item -LiteralPath` silently no-ops

Spent the first half of the chunk-3 landing watching `Copy-Item`
"succeed" with zero errors while the destination file stubbornly
remained the previous version. Three rounds of `pnpm exec tsc` /
restart / hard-reload before noticing the destination's
`LastWriteTime` hadn't moved.

Root cause: `Copy-Item "$source" -LiteralPath "$dest"` is a malformed
parameter combination. `Copy-Item` has two parameter sets: one uses
`-Path` for the source, the other uses `-LiteralPath`. Mixing a
positional source with `-LiteralPath` on the destination puts the
parameter resolver into a state where it interprets the positional
argument as a SECOND source path and silently drops the copy. No
error, no warning. The file stays put.

The working form is `Copy-Item -Path $src -Destination $dest -Force`.
Explicit on both sides. The path-with-brackets problem (the `[id]`
folder) is solved by `Set-Location -LiteralPath '[id]'` first and then
copying with a plain destination filename, not by `-LiteralPath` on
`Copy-Item`.

Workflow update: every project file with a bracket segment in its
path now gets the temp-file-then-Set-Location pattern.

### Browser cache served a stale file under the same name

After the first chunk-3 patch attempt failed (the actual issue was
the `-LiteralPath` no-op above), we re-downloaded the file three
times and re-ran the copy. The destination still didn't update.
Eventually noticed the source file in `~/Downloads` had a `May 16,
9831 bytes` timestamp - it WAS the old file. The browser was
de-duplicating the download against a cached entry under the same
filename and silently serving the cached version.

Workaround: I started suffixing replacement files with `-V2` / `-V3`
so the browser couldn't match against any cached download. The
copy commands then have to reference the new name. Slightly ugly
but bypasses the cache entirely.

Worth noting: the curated snapshot script intentionally regenerates
to a different output path each run (`docs/key-files-snapshot.md`)
which means it can't trigger this cache issue. The file-drop pattern
in chat is more brittle.

### Snapshot script timestamp pre-Day-6

The pasted `app/dashboard/tenders/[id]/page.tsx` opened on Day 7 had
a May-16 timestamp - which is Day 4's window. The file in
`key-files-snapshot.md` (curated) was the post-Day-5 version with the
reversal buttons. Both were "current" depending on what you mean by
current - the disk file hadn't been touched since the reversal work,
which was correct.

No bug, just a momentary confusion. The principle from the Day-7
workflow (`code wins when docs and code disagree`) held - I read the
pasted code, not the snapshot, before editing.

---

## Known technical debt

Carried forward from prior days.

- **Timestamp format inconsistency.** Still open. SQLite
  `datetime('now')` produces `"2026-05-22 14:33:21"`; JS
  `toISOString()` produces `"2026-05-22T14:33:21.000Z"`. The Day-7
  `formatRelativeTime` helper handles both, using the same
  normalisation pattern as `isWithinRecallWindow` - swap space for
  "T" and append "Z". Same surface as Day 5: bug class is contained
  by the readers.

- **`companies.annualTurnover` column.** Still missing. The
  `applyToTender` turnover gate is still stubbed with a TODO. Strong
  Day 8 candidate.

- **`listTenders` company-role draft visibility.** Still uses a JS
  post-filter rather than a SQL OR clause. Fine at Phase 1 scale.

- **`markAwarded` doesn't capture the winning company.** Awaits the
  `awardedCompanyId` column when Phase 2 (project tracking) lands.

- **No FK on `audit_log.actor_id` or `target_id`.** Deliberate
  choice. The Day-7 resolver handles the dangling-pointer case
  gracefully via "Deleted item" rendering - first consumer to
  exercise it.

- **`KNOWN_ACTIONS` set duplicates the union.** New Day-7 debt. The
  row component now has a runtime `Set<AuditAction>` that has to be
  kept in lockstep with the union in `lib/audit/log.ts` AND the
  `LABELS` record in `lib/audit/labels.ts`. Three sources of truth
  is one too many. Refactor option: derive `KNOWN_ACTIONS` from
  `Object.keys(LABELS)` at module load.

- **Tender-history applications fan-out fetches 200 rows globally.**
  New Day-7 debt. JS post-filter by `metadata.tenderId`. Bounded
  cost at Phase 1 scale, correctness concern past ~10k audit rows.
  Fix is a dedicated `listAuditEventsForTender` helper.

- **Phase-1 cross-actor visibility gap.** New Day-7 debt, surfaced
  by the visibility tests. Applicants don't see tender-level events
  on tenders they applied to. Company-role users on their own
  company detail page only see their own actions, not staff-actor
  edits. Real value to fix.

---

## What's next

Two Day-8 candidates lead by a clear margin:

### 1. `companies.annualTurnover` migration + activate the turnover gate

Smallest possible delta, highest visible value. The schema work is a
single column migration. The action work is removing the existing
TODO in `applyToTender` and replacing it with a real comparison
against `companies.annualTurnover`. The form work is a number input
on the company create/edit form with the same INR-locale formatting
as the tender-side `minAnnualTurnoverInr` field. Maybe one chunk for
the schema + action, one chunk for the form.

This has been deferred since Day 4. It's been called out in Day 4,
Day 5, Day 6, and Day 7 reports. Time to ship it.

### 2. Documents module kickoff

R2 bucket, schema, presigned-URL upload flow. First session of a
3-4 session arc. Bigger thread; more thinking up front. The
right starting point is the schema + the R2 client wiring + a
proof-of-concept upload flow. UI for the documents tab on company
detail comes later in the arc.

Either is a reasonable Day 8 thread. The turnover column is the
smaller, more boring, higher-leverage option. The documents module
is the bigger, more interesting, longer-arc option.

Other candidates lower on the priority list:

- Phase 1B cross-actor visibility for the activity feed
- Filter chips on the dashboard widget
- `KNOWN_ACTIONS` refactor (derive from `LABELS`)
- Dedicated `listAuditEventsForTender` helper

---

## How to run it locally

```powershell
# From the repo root
pnpm install
pnpm dev
# App at http://localhost:3000

# Default seeded users
# admin@consultway.local   / ChangeMe123!  (Admin role)
# staff@consultway.local   / ChangeMe123!  (Staff role)
# acme@example.local       / ChangeMe123!  (Company role, linked to Acme Construction)
```

To verify the Day 7 work end-to-end:

1. Sign in as admin. Visit `/dashboard`. The "Recent activity" card
   should show your most recent audit events with iconography per
   verb.

2. Click any row's "details" link. An indented muted panel should
   expand showing each changed field as "old -> new". Click "hide
   details" to collapse.

3. Visit `/dashboard/tenders` and click any tender. Scroll past the
   Applications card. A "History" card should show that tender's
   events plus its applications' events, merged and sorted
   newest-first.

4. Visit `/dashboard/companies` and click any company. Same shape:
   "History" card below the overview, showing that company's events.

5. Sign out and sign in as `acme@example.local`. Repeat the
   dashboard / tender / company walks. The feed should be scoped to
   Acme's own actions and applications. Other companies' events
   should not appear.

6. Verify reversal-verb rendering: find a tender you've retracted
   the award on (or do it now). The History row should be Terracotta-
   toned with the reason rendered as italic text. The expand panel
   should show the status field flip.

---

## Commits shipped today

```
<chunk4 hash>  feat(audit): expand-on-click diff panel on activity-feed rows (Chunk 4)
98a5eab        feat(audit): per-entity History sections on tender and company detail (Chunk 3)
a577816        feat(audit): dashboard activity feed widget (Chunk 2)
7554b4e        feat(audit): add shared activity-feed primitives (Chunk 1)
```

Plus the Day 7 wrap commit which will contain the regenerated
project snapshot (`docs/project-tree.md` and
`docs/key-files-snapshot.md`) and this report.
