# Day 19 — Reports module foundation + CSV export consolidation + schema doc rebaseline

_Date: 2026-05-23_

## Scope

Surfaces on top of Day-18's dashboard widgets. No new migrations, no
new tables — period-bounded variants of the Day-18 aggregates power a
new `/dashboard/reports` surface; the third CSV exporter earns the
`lib/csv.ts` abstraction; and the schema doc finally catches up with
five sessions of code drift. Three deliverable chunks, each its own
commit on `dev`:

1. **Reports module foundation.** Three new period-bounded aggregate
   helpers (`getProjectsByStatusForPeriod`,
   `getTendersByStatusForPeriod`, `getTransactionsSummaryForPeriod`)
   plus the `/dashboard/reports` landing with period picker + three
   summary cards. `getTransactionsSummaryThisMonth` becomes a thin
   wrapper over the period helper.
2. **Per-tender CSV + shared lib/csv.ts.** Third occurrence of the
   pattern earns its keep — `csvCell`, BOM, CRLF, filename stamp, and
   `serialiseCsvRows` lift into `lib/csv.ts`. Transactions and projects
   exports refactor to consume them; a new tenders exporter lands
   alongside its export route handler + Export CSV button on the list.
3. **Schema doc rebaseline + EmptyState sweep + dead-code cleanup.**
   Carry-forward chunk. Doc-pass on top of Day-18's schema, sweep five
   empty-state callsites onto the Day-18 `<EmptyState>` primitive, and
   delete the post-Day-18 dead `activity-feed.tsx`.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 459/459 green every run (was 432; +27 net);
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean.

## What shipped

### Chunk 1 — Reports module foundation (commit `ac39eac`)

**`lib/dashboard/aggregates.ts` — three period-bounded siblings:**

- `getProjectsByStatusForPeriod(scope)` — like `getProjectsByStatus`
  but additionally filters `projects.createdAt` inside `[start, end]`.
  Both bounds are inclusive — the upper bound is anchored to
  end-of-day UTC (`YYYY-MM-DD 23:59:59`) because the `createdAt`
  column is an ISO-8601 timestamp, not date-only, and a naive
  `<= 'YYYY-MM-DD'` would miss rows created later in the day.
- `getTendersByStatusForPeriod(scope)` — filters on
  `tenders.publishedAt`, NOT `createdAt`. A draft created in January
  but published in March belongs to March's report. Drafts that never
  publish (`publishedAt IS NULL`) never appear in any period — the
  NULL exclusion is implicit (`NULL` doesn't satisfy `gte`/`lte` in
  SQLite, no extra clause needed).
- `getTransactionsSummaryForPeriod(scope)` — admin-only via the
  module's existing `requireAdmin` helper. Takes `{ start, end,
  companyId? }`. The company narrowing supports the
  "single-company financials over period X" report. `occurredOn` is
  date-only on the schema, so the inclusive-end bound doesn't need
  the end-of-day anchor that the timestamp columns do.

All three Zod-validate via a shared `periodScopeSchema` (ISO date-only
regex on `start` + `end`, optional UUID `companyId`).

**`getTransactionsSummaryThisMonth` refactored into a wrapper.**
The Day-18 dashboard widget keeps the same exported function name +
same return shape (`{ monthStart, monthEnd, ... }`); the
implementation is a one-line call to the new period helper with the
current-month bounds. The dashboard's `MonthTransactionsSummaryCard`
needed zero edits.

**`/dashboard/reports` Server Component (admin/staff only):**

- Reads `?from=YYYY-MM-DD&to=YYYY-MM-DD&companyId=` from the URL.
  Defaults to current calendar month (UTC) when `from`/`to` are
  unset — same window as the Day-18 dashboard's per-month
  transactions card.
- Company-role → redirect to `/dashboard` (the report aggregates
  aren't designed for the company slice; a future need lands as a
  separate surface).
- Layout: PageHeader → period picker → two-column grid (Projects +
  Tenders summary) → admin-only Transactions summary below.
- Each summary card sits inside its own Suspense boundary keyed on
  `(start, end, companyId)` so changing the period re-streams without
  blocking the picker.

**Four new presentational primitives in `app/dashboard/reports/_components/`:**

- `period-picker.tsx` — Client Component with two date inputs + four
  preset chips ("This month", "Last month", "This quarter", "Year to
  date"). URL-shaped state — every interaction rewrites the URL via
  `router.replace`; no client-side mirror. Date math (month boundary,
  quarter start) lives in pure helpers, mirroring the
  `currentMonthBoundsUtc` helper in `lib/dashboard/aggregates.ts`.
- `projects-summary-card.tsx` — Server Component. Per-status rows for
  projects created in the period. Empty-period case renders "No
  projects created in this period." in place of the rows.
- `tenders-summary-card.tsx` — Same shape for tenders. Empty case
  renders the tenders-flavoured message.
- `transactions-summary-card.tsx` — Admin-only. Cosmetic descendant
  of Day-18's `MonthTransactionsSummaryCard` — same five-cell grid +
  grand-total footer, but the period bounds come from props rather
  than the current-month helper. Lives alongside the dashboard card
  rather than refactoring it (dashboard stays current-month-only;
  this one is period-bounded).

**Tests in `lib/dashboard/__tests__/aggregates-period.test.ts` (+11):**

Fixture seeds 6 projects (2 in-period start-boundary + mid + end +
boundary out-of-period rows), 5 tenders (1 draft created-in-period
that MUST NOT count + 3 published in-period across statuses + 1
published-before-period), 7 transactions (5 in-period + 2 outside,
covering both date boundaries).

- `getProjectsByStatusForPeriod` counts only in-period creates,
  including both boundary days.
- `getProjectsByStatusForPeriod` boundary inclusivity pinned by
  single-day windows on `start` and `end`.
- `getProjectsByStatusForPeriod` zero-fills every status on an empty
  period.
- `getProjectsByStatusForPeriod` narrows by `companyId`.
- `getTendersByStatusForPeriod` filters on `publishedAt` — the
  in-period DRAFT (no `publishedAt`) MUST NOT count.
- `getTendersByStatusForPeriod` zero-fills.
- `getTransactionsSummaryForPeriod` admin sees the cross-company
  period total.
- `getTransactionsSummaryForPeriod` narrows correctly when
  `companyId` is set (Acme + BuildRight both verified).
- `getTransactionsSummaryForPeriod` refuses staff caller.
- `getTransactionsSummaryForPeriod` refuses company-role caller.
- `getTransactionsSummaryForPeriod` boundary inclusivity pinned by
  single-day windows on `start` and `end`.

Total at end of Chunk 1: **443 tests** (was 432; +11).

### Chunk 2 — Per-tender CSV + shared lib/csv.ts (commit `af6d88b`)

**`lib/csv.ts` — shared primitives:**

- `csvCell(raw)` — RFC-4180 escape. NULL / undefined / empty → empty
  cell; embedded comma / double quote / CR / LF → wrapped in double
  quotes with internal double quotes doubled.
- `CSV_BOM` — the `"﻿"` literal so Excel-on-Windows opens the
  file in UTF-8 mode.
- `CSV_LINE_ENDING` — the `"\r\n"` literal (RFC-4180).
- `csvFilenameDateStamp(now?)` — YYYY-MM-DD stamp for the
  `Content-Disposition` filename.
- `serialiseCsvRows(headerCells, dataRows)` — composes header + rows
  with the BOM + CRLF boilerplate. Per-domain modules build their
  cell arrays (where the formatters live) and hand them in.

**`lib/transactions/csv.ts` + `lib/projects/csv.ts` refactored.**
Both now consume `csvCell` + `serialiseCsvRows`. The domain-specific
formatters (paise-with-decimal for transactions, tender-ref UUID
truncation for projects, rupees-integer for project budgets) stay
local. Existing public API preserved via re-exports:
- `csvFilenameDateStamp` re-exported from `lib/transactions/csv.ts`
  so `app/dashboard/transactions/export/route.ts` keeps working
  without an import-path edit.
- `csvFilenameDateStamp as projectsCsvFilenameDateStamp` re-exported
  from `lib/projects/csv.ts` for the same reason.

**`lib/tenders/csv.ts` — new exporter:**

- Columns: Title, Status, Reference, Publisher, Sector, Geography,
  Opening, Closing, Awarded company, Published at.
- One company-name lookup map handles both `publisherCompanyId`
  (NOT NULL on schema) and `awardedCompanyId` (NULLABLE).
- NULL handling on every nullable column → empty cells.

**`app/dashboard/tenders/export/route.ts` — new admin/staff GET:**

- 1000-row hard cap (matches the transactions / projects exporters).
- Forwards `status`, `publisherCompanyId`, `sector`, `geography`,
  `search` from the list page.
- Company-role → 403; unauthenticated → 401.
- Single-IN-query company lookup covers both publisher + awardee.

**Tenders list page — Export CSV button wired in:**

- `app/dashboard/tenders/page.tsx` — "Export CSV" button in the
  PageHeader actions, visible only when `canCreate` (admin/staff).
  Mirrors the projects / transactions list's button shape. Forwards
  the URL's current filter params through.
- `buildExportHref` helper localised to the page — same precedent as
  the projects / transactions lists.

**Tests in `lib/__tests__/csv.test.ts` (+11):**

- `csvCell` happy path (no escape needed).
- `csvCell` wraps a value containing a comma.
- `csvCell` wraps and doubles an embedded double quote.
- `csvCell` wraps a value containing CR or LF.
- `csvCell` returns empty string on null / undefined / empty input.
- `serialiseCsvRows` composes header + rows with BOM + CRLF.
- `serialiseCsvRows` escapes each cell through `csvCell`.
- `serialiseCsvRows` renders a header-only CSV when given an empty
  data-rows list.
- `serialiseCsvRows` renders empty cells for null / undefined entries
  in a data row.
- `csvFilenameDateStamp` returns YYYY-MM-DD for a given date.
- `csvFilenameDateStamp` defaults to today when no argument is passed.

**Tests in `lib/tenders/__tests__/csv.test.ts` (+5):**

- Header row + correct value formatting (BOM, CRLF, publisher resolved,
  awarded-company empty).
- NULL handling on every nullable column (reference, opening, closing,
  awarded, published-at) — empty cells.
- Awarded-company lookup resolves when set; missing lookup → empty
  cell.
- RFC-4180 escape on titles with embedded commas + double quotes;
  publisher name with a comma.
- Publisher always resolves (NOT NULL on schema) — pinned by an
  empty-lookup row that renders the publisher cell empty rather than
  crashing.

Existing tests in `lib/projects/__tests__/csv.test.ts` (+0 edits) and
`lib/transactions/__tests__/rollups-and-csv.test.ts` (+0 edits)
continue to pass post-refactor.

Total at end of Chunk 2: **459 tests** (was 443; +16).

### Chunk 3 — Schema doc rebaseline + EmptyState sweep + dead-code cleanup (commit `dacffb6`)

**`docs/05-database-schema.md` rebaseline:**

- `companies.annual_turnover` row added (Day 8) — whole-rupees
  semantics, NULL = unstated, called out as the eligibility-gate
  comparator against `tenders.min_annual_turnover_inr`. The legacy
  `annual_turnover_paise` row above it is flagged as
  doc-historical-not-implemented.
- `email_verification_tokens` section added (Day 15) — SHA-256
  hashed tokens, 24h expiry, cascade-delete with user, the two-step
  mint/consume lifecycle documented.
- `password_reset_tokens` section added (Day 15) — same shape, 1h
  expiry, sibling-invalidation on consume.
- `projects` section rewritten (Day 16) — accurate column list
  (`name`, `description`, `tender_id`, `company_id`, `status`,
  `start_date`, `end_date`, `budget_inr`, `internal_notes`), cascade
  rules (tender SET NULL, company RESTRICT), 5-status union, rupees
  budget regime, 4 indexes. The pre-Day-16 columns that don't exist
  (`code`, `sector`, `budget_paise`, `target_end_date`,
  `actual_end_date`, `created_by`) flagged as never-implemented.
- `transactions` section rewritten (Day 17) — accurate column list,
  paise precision regime, RESTRICT cascade on both FKs, the
  cross-FK invariant (project.companyId === transaction.companyId)
  called out, 6 indexes. The pre-Day-17 columns that don't exist
  (`direction`, `attachments`, `recorded_by`) flagged.
- `milestones` and `project_activity` marked DEFERRED — milestones
  aren't implemented today; project activity is covered by the
  cross-cutting `audit_log` with `target_type = "project"` rather
  than a dedicated table.
- ERD updated to flag the deferred tables AND add the two token
  table → users edges.
- Footer added: "Last synced through migration **0012** (Day 19
  rebaseline pass)."

**`<EmptyState>` sweep — five existing call sites consolidated:**

- `app/dashboard/companies/_components/companies-table.tsx` — table
  empty pane.
- `app/dashboard/tenders/_components/tenders-table.tsx` — same.
- `app/dashboard/projects/_components/projects-table.tsx` — same;
  `canCreate`-gated description preserved.
- `app/dashboard/transactions/_components/transactions-table.tsx` —
  same.
- `components/audit/activity-feed-empty.tsx` — wraps its inner shell
  in `<EmptyState>` (keeps the Clock icon + default copy + the
  `description` prop) so the dashboard activity feed picks up the
  consolidated visual without touching any of its callers.

Each call site keeps its own copy + icon; only the chrome (icon disc
geometry, spacing, text hierarchy) consolidates. Visual diff is
near-zero.

**`activity-feed.tsx` dead-code deletion:**

- `app/dashboard/_components/activity-feed.tsx` had zero importers
  post-Day-18 (the dashboard page now mounts `<RecentActivityCard>`
  instead). Grep-confirmed and deleted.
- `app/dashboard/_components/activity-feed-loading.tsx` STAYS — it's
  still the Suspense fallback in the new dashboard's
  `<RecentActivityCard>` wiring. Verified by re-reading the page.

**Tests:** no new tests this chunk by design — the doc edit is
non-code, the EmptyState refactor is purely presentational, the file
deletion is a grep-confirmed unused module.

Total at end of Chunk 3: **459 tests** (unchanged from Chunk 2).

## Key decisions

**`publishedAt` not `createdAt` for the tenders-period filter.** A
draft created in January but published in March belongs to March's
report. Counting it under January would conflate "we drafted it" with
"we put it on the market", which is the actual report-relevant fact.
Drafts that never publish should never appear in any period — they're
internal-only state. SQLite's `NULL` doesn't satisfy `gte`/`lte`, so
the NULL exclusion is implicit; no extra clause needed.

**`createdAt` for the projects-period filter.** Projects don't have a
separate "we actually started" stamp today, so `createdAt` is the
right proxy. If `startedAt` ever lands as a distinct column, the
filter can move; for now `createdAt` is "when the row came into being
on the platform", which is the closest available signal for "what
projects landed this quarter."

**End-of-day UTC anchor on timestamp-column upper bounds.** The
`createdAt` and `publishedAt` columns are ISO-8601 timestamps
(`2026-05-23 14:30:00`), not date-only strings — comparing them to
`YYYY-MM-DD` strings lexicographically works for the lower bound
(`'2026-05-01' <= '2026-05-01 00:00:00'`) but fails on the upper
bound (`'2026-05-31' < '2026-05-31 14:30:00'`). The helper anchors
the upper bound to `'YYYY-MM-DD 23:59:59'` to keep the
inclusive-on-both-ends contract. `occurredOn` is date-only so the
transactions helper doesn't need this anchor — pinned by the
boundary test that asserts a row dated `2026-05-31` lands in the
`[2026-05-31, 2026-05-31]` single-day window.

**`getTransactionsSummaryThisMonth` becomes a one-line wrapper.** The
Day-18 dashboard card calls this directly. The refactor keeps the
exported function name + return shape (`{ monthStart, monthEnd, ... }`)
identical — only the implementation changes. The dashboard widget
and its 10 existing tests keep passing with zero edits. The
period-bounded helper is the new primitive; the month-bounded one is
a convenience wrapper for the dashboard's preserved call site.

**Period picker is URL-shaped, no client state.** Every interaction
rewrites the URL via `router.replace`; the parent Server Component
re-renders with the new searchParams. Keeps the picker compatible
with browser back/forward navigation and lets reports be deep-linked
("here's the link to last quarter's view"). The preset chips are
pure URL-rewriters that compute their own bounds in UTC. Active-chip
detection runs on every render — a "This month" chip that was active
yesterday isn't active today (the boundary moved), which is the
right behaviour.

**Default period = current month (UTC), not "all time" or last 30
days.** Matches the dashboard's per-month transactions card's window
so the no-arg landing feels like a familiar entry point. A user who
wants "the whole year" picks YTD from the preset row; we don't
guess.

**Reports module is HTML-only this session.** PDF generation lands
Day 20 (Phase 3). The brief asked for the foundation: stable date-
range routing, period-bounded aggregates, and the first three cards.
Day 20's PDF surface prints from this same data layer.

**Cards on the reports page DON'T drill through.** Unlike the
dashboard's `StatusBreakdownCard`, the reports cards render the
count without a link. The figures pivot the report, not a deeper
navigation, and a click that left the report and lost the period
would feel jarring. If a "show me the rows behind this number"
need emerges, it lands as a per-row drill-button rather than the
whole-row click target.

**Third-occurrence threshold for `lib/csv.ts`.** Day 17 (transactions),
Day 18 (projects), Day 19 (tenders) — three is the right moment. The
divergent parts (paise-vs-rupees, tender-ref truncation, etc.) stay
in the per-domain modules. Don't over-abstract: `tendersToCsv` is
still its own function, not a `domainToCsv<T>` generic. Just the
cell escape, BOM, CRLF, and filename-stamp helpers move.

**Re-export `csvFilenameDateStamp` from the per-domain modules.** The
existing route handlers
(`app/dashboard/{transactions,projects}/export/route.ts`) import
`csvFilenameDateStamp` / `projectsCsvFilenameDateStamp` from their
per-domain CSV modules. A re-export preserves the existing import
paths so the refactor is zero-touch on the route handlers — the
boilerplate lives in one place, the public API stays stable.

**Tenders export gate is admin/staff, not admin-only.** Matches the
projects exporter (admin/staff) rather than the transactions
exporter (admin-only). The list page is admin/staff visible — its
filter set isn't admin-only — so the export gates the same way.
Company-role gets 403 (their own listing isn't designed for bulk
sharing).

**`publisherCompanyId` always resolves — pinned by a test.** The
schema's ON DELETE RESTRICT cascade should make a missing-publisher
case unreachable in production, but the helper degrades gracefully
to an empty cell rather than crashing. Pinned by an
empty-lookup-map test so the contract is explicit.

**Schema doc rebaseline matches the doc's own voice.** The new
sections mirror the existing depth — `projects` ≈ the existing
`tenders` section's shape; `transactions` is the biggest add (paise
regime + cross-FK invariant warrant the extra prose). Where existing
doc rows describe columns that don't actually exist (e.g.
`projects.code` / `transactions.direction`), the spec is annotated
"code wins" rather than deleted — the doc remains a history of
intent, even where intent diverged from implementation.

**Milestones and project_activity flagged DEFERRED, not deleted.**
Both were specced for Day 18 but never implemented (project activity
is covered by the cross-cutting `audit_log` with
`target_type = "project"`; milestones simply aren't modelled today).
Deleting the spec sections would erase the design intent; flagging
them as deferred preserves the option without misleading the reader
about current state.

**`<EmptyState>` sweep is presentational only.** Each of the five
call sites keeps its current copy. Only the chrome consolidates.
Projects-table's `canCreate`-gated description prop survives the
refactor (it was the trickiest fit; passing the gated string
through `description` works cleanly because `<EmptyState>` accepts
a string, not a node).

**`activity-feed-loading.tsx` is NOT deleted.** It's still the
Suspense fallback in `<RecentActivityCard>`'s call site
(`app/dashboard/page.tsx:56`). Only `activity-feed.tsx` (the
wrapper that pulled in the resolver + rendered the feed inline)
is post-Day-18 dead code. Grep-confirmed before deleting.

## Gotchas surfaced

**Latent perPage cap on the CSV exporters.** All three exporters
(`/dashboard/{transactions,projects,tenders}/export`) pass
`perPage: String(EXPORT_ROW_CAP)` where `EXPORT_ROW_CAP = 1000`, but
the matching `list*QuerySchema` Zod schemas all cap `perPage` at
**100**. The first 1000-row export request would Zod-fail
("Number must be less than or equal to 100") and return a 400. Not a
Day-19 regression — the pattern's been in place since Day 17/18 and
no production export has been used yet. **Followup: either widen
the Zod cap on export-only callers or have the export routes accept
a wider override schema.** Tracked as carry-forward #6 below.

**ISO timestamp vs ISO date-only comparison asymmetry.** The two
projects/tenders period helpers needed an end-of-day anchor on the
upper bound (`'YYYY-MM-DD 23:59:59'`) because the `createdAt` /
`publishedAt` columns are timestamps. The transactions helper does
NOT need the anchor because `occurredOn` is date-only. Easy to
miss — both columns "store dates" — but the underlying SQLite text
shapes are different, and the lexicographic comparison cares.

**The period-picker preset chips are anchored on the clock at
render time.** "This month" computed on May 23 matches the URL
`from=2026-05-01&to=2026-05-31`; the same chip computed on June 1
matches `from=2026-06-01&to=2026-06-30`. The chip detection runs
on every render so this is correct out of the box, but a future
refactor that tries to "cache" the preset value would silently
go stale.

**`date` inputs return YYYY-MM-DD even when the user clears them.**
The `onChange` handler guards with a regex match before pushing to
the URL — without that guard, clearing the input would write
`from=` (empty) and the parent's `resolvePeriod` would fall back to
the current month, which would feel like a UX bounce. Empty-input
state is silently swallowed; the URL preserves the last good range.

**`Promise.resolve(null)` for non-admin slots in the dashboard's
parallel fetch.** The Chunk 1 refactor preserved this pattern — the
Day-18 dashboard widget calls `getTransactionsSummaryThisMonth`,
which is admin-only, but the page tests for `isAdmin` and passes a
`null` placeholder for non-admins to keep the array's element-
position-to-meaning contract stable. The wrapper's return shape
didn't change, so this code didn't need editing.

**Schema doc `annual_turnover_paise` legacy row.** The doc's
original `companies` table listed `annual_turnover_paise` (the
paise variant). The actual implementation uses `annual_turnover`
(whole rupees). Rather than delete the legacy row I added the
correct one below it with a "code wins" annotation — preserves the
history of intent without misleading future readers.

## Surfaces touched

```
# Chunk 1 — Reports module foundation (commit ac39eac)
app/dashboard/reports/_components/period-picker.tsx                  (new — URL-shaped picker)
app/dashboard/reports/_components/projects-summary-card.tsx          (new — period-bounded card)
app/dashboard/reports/_components/tenders-summary-card.tsx           (new — period-bounded card)
app/dashboard/reports/_components/transactions-summary-card.tsx      (new — admin-only)
app/dashboard/reports/page.tsx                                       (new — admin/staff landing)
lib/dashboard/__tests__/aggregates-period.test.ts                    (new — 11 tests)
lib/dashboard/aggregates.ts                                          (modified — +3 period helpers + wrapper refactor)

# Chunk 2 — Per-tender CSV + shared lib/csv.ts (commit af6d88b)
app/dashboard/tenders/export/route.ts                                (new — admin/staff GET)
app/dashboard/tenders/page.tsx                                       (modified — Export CSV button + helper)
lib/__tests__/csv.test.ts                                            (new — 11 tests)
lib/csv.ts                                                           (new — shared primitives)
lib/projects/csv.ts                                                  (modified — consume shared)
lib/tenders/__tests__/csv.test.ts                                    (new — 5 tests)
lib/tenders/csv.ts                                                   (new — tendersToCsv helper)
lib/transactions/csv.ts                                              (modified — consume shared)

# Chunk 3 — Schema doc + EmptyState + dead-code (commit dacffb6)
app/dashboard/_components/activity-feed.tsx                          (deleted — zero importers post-Day-18)
app/dashboard/companies/_components/companies-table.tsx              (modified — EmptyState)
app/dashboard/projects/_components/projects-table.tsx                (modified — EmptyState)
app/dashboard/tenders/_components/tenders-table.tsx                  (modified — EmptyState)
app/dashboard/transactions/_components/transactions-table.tsx        (modified — EmptyState)
components/audit/activity-feed-empty.tsx                             (modified — wraps EmptyState)
components/ui/empty-state.tsx                                        (modified — updated docstring)
docs/05-database-schema.md                                           (modified — rebaseline pass)

# Day 19 report (this commit)
docs/reports/day-19-report.md                                        (new)
```

## Test totals

Before this session: **432 tests across 22 files**, all green (Day 18
end state).

After this session: **459 tests across 25 files**, all green every
run. Net: **+27**.

Breakdown of the delta:

- +11: `lib/dashboard/__tests__/aggregates-period.test.ts` (Chunk 1)
- +11: `lib/__tests__/csv.test.ts` (Chunk 2)
- +5:  `lib/tenders/__tests__/csv.test.ts` (Chunk 2)

The brief budgeted ~18-22 new tests; landed at +27 — slightly above
range, driven by the `lib/csv.ts` test file batching all six
RFC-4180 cases plus the BOM/CRLF/empty-data assertions for
`serialiseCsvRows`. Chunk 3 deliberately added zero tests
(presentational refactor + doc-pass + grep-confirmed dead-code
deletion).

## Followups for Day 20+

**From this session:**

1. **Latent perPage cap on the CSV exporters.** All three exporters
   pass `perPage=1000` but the matching Zod schemas cap at 100. First
   1000-row request returns a 400. Pre-Day-19 pattern; fix by
   either widening the cap on export-only callers or by giving the
   export routes a wider override schema. Worth a small follow-up
   commit before the first prod export.
2. **PDF report generation.** Day 20 scope. The HTML surface this
   session lands prints cleanly with no dynamic content; a Workers-
   safe PDF renderer (`@react-pdf/renderer` per the phases doc) can
   take the same three card components and emit a branded PDF.
3. **Charts / sparklines on report cards.** Not in this session per
   the brief. The cards' rows are deliberately static today; a future
   UX pass can add per-status bars or trend lines without changing
   the data layer.
4. **Period-over-period comparison.** Future session — the period
   helpers take an arbitrary `(start, end)` pair, so adding a second
   "previous period" panel is a layout change, not a data-layer
   change.
5. **`?companyId=` UX on the report.** The picker doesn't surface a
   company selector today; the URL parameter is honoured by the
   helpers but only reachable via direct-link. A future iteration
   adds a select bar.
6. **Searchable typeahead selects on the project / transaction /
   tender forms.** Phase-1 scale; same followup that's been carried
   since Day 17.
7. **Per-document CSV export.** Separate session — file-size column
   is paise-like in its own way and needs a small design pass.
8. **Bulk CSV import.** Inverse of the export. Trivial parser given
   the export shape, but the cross-FK invariants + uniqueness
   constraints mean it deserves its own design pass.
9. **Saved-report-config persistence.** Today the URL is the
   shareable form. A future pass adds named saved-reports
   ("Quarterly board pack") with their own permissions.

**Carried forward from Day 18 (unchanged):**

10. **Dashboard widget loading skeletons.** The dashboard's
    projects + tenders breakdown cards render inline today. When the
    page lands on a slower link, lifting them into their own
    `<Suspense>` boundaries would smooth the first-paint. The
    reports page already does this for its three cards (Day 19
    precedent).
11. **`deleteProject` action.** Carry-forward from Day 16. Needs its
    own confirm flow + R2-cleanup story + soft-delete-vs-hard-delete
    design pass.
12. **Project-attached documents.** Schema doesn't currently link
    documents to projects. Separate session.
13. **Side-by-side detail view at desktop widths.** Project /
    transaction / company detail pages would benefit from a 3-column
    layout on `xl:` widths.
14. **`TransactionTypeBadge` / `ProjectStatusBadge` /
    `TenderStatusBadge` share a palette pattern.** Day 16/17/18/19
    all flagged this; still premature. The cost of waiting is low.
15. **`updateTransaction` audit `typeChange` only — `companyId`
    not patchable.** companyId-change correction goes via delete +
    recreate. Followup if/when in-place re-tag becomes a real
    workflow need.

**Carried forward from Day 16 / 15 (unchanged):**

16. **Session invalidation on password reset.** Phase-3 hardening.
17. **Multi-step registration UX.** Wizard UI for `/register`.
18. **CAPTCHA / rate limiting** on `/register`, `/forgot-password`,
    token-consume endpoints.
19. **Public tender browsing.**
20. **Token cleanup cron.**
21. **Hoist `escapeHtml` to a shared helper.**
22. **`@opennextjs/cloudflare` install + `open-next.config.ts`.**
23. **D1-backed Drizzle client factory.**
24. **Resend domain verification + production secret.**
25. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
26. **Seed self-healing on changed fixtures.**
27. **Stage real fixtures into R2.**

**Already-resolved this session:**

- Day-18 followup #1 (EmptyState sweep) — landed in Chunk 3.
- Day-18 followup #3 (activity-feed.tsx dead-code deletion) — landed
  in Chunk 3.
- Day-18 followup #6 (per-tender CSV export) — landed in Chunk 2.
- Day-18 carry-forward #26 (`docs/05-database-schema.md` rebaseline) —
  landed in Chunk 3.

## Carry-forward to Day 20

- **`dev` ended at 3 commits past Day-18's report commit (`5e1d43c`)**
  before this report's own commit: `ac39eac` / `af6d88b` /
  `dacffb6`. Run `git log origin/dev..dev --oneline` for the
  up-to-date set — pushing still requires explicit approval per
  `<permissions>`.
- **459 tests passing on every run.** Three new test files added
  (Chunk 1 aggregates-period + Chunk 2 csv + Chunk 2 tenders/csv).
  No existing test files needed editing.
- **Schema stays at migration 0012.** No new migration this session.
  Per the autonomous-mode scope: surfaces on top of the existing
  schema only.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` — expected Day-12 dedup row.
- **`pnpm cron:pending-cleanup`** clean.
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 19 didn't
  add new emails.
- **`PASSWORD_PEPPER`** unchanged.
- **`lib/csv.ts` is now the single source for CSV boilerplate.**
  Three per-domain exporters consume it. A fourth (documents,
  flagged as carry-forward) would slot in trivially.
- **`/dashboard/reports` is admin/staff-only.** Company-role users
  redirect to `/dashboard`. A future iteration that needs a
  company-scoped report lands as a separate surface.
- **Period-bounded aggregates take ISO date-only strings on their
  public API.** The URL is the source of truth for the date range;
  Date object construction (for SQL clauses) lives inside the
  helpers.
- **`getTransactionsSummaryThisMonth` is a wrapper now.** The
  dashboard's `MonthTransactionsSummaryCard` and its 10 existing
  tests keep passing unchanged.
- **`<EmptyState>` is now wired across every list page + the audit
  feed.** New consumers reach for it directly; existing call sites
  consolidated this session.

That's Day 19.
