# Day 18 — Admin dashboard widgets + per-company financial panel

_Date: 2026-05-23_

## Scope

Surfaces on top of Day-17's transactions schema. No new migrations,
no new tables — purely lifting the existing aggregate helpers into
the dashboard and the company detail page, plus a projects CSV
export that mirrors Day-17's transactions one. Three deliverable
chunks, each its own commit on `dev`:

1. **Admin dashboard widgets.** Replaced the Day-1 placeholder
   `/dashboard` page with role-aware KPI tiles, per-status breakdown
   cards, an admin-only per-month transactions summary card, and the
   refreshed recent-activity feed. Lands the new
   `lib/dashboard/aggregates.ts` module with four pure-read helpers.
2. **Per-company financial panel + cross-links.** Mirrors the Day-17
   per-project rollup card onto the company detail page (admin-only).
   Wires a rollup banner above the transactions list when a single
   company is in scope. Folds in Day-17 followup #7 (audit
   `metadata.typeChange` on `updateTransaction`).
3. **Projects CSV export + small polish.** Mirrors the Day-17
   transactions CSV shape for projects (whole-rupees regime, no paise).
   Adds the reusable `<EmptyState>` primitive for future surfaces.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 432/432 green every run (was 409; +23 net);
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean.

## What shipped

### Chunk 1 — Admin dashboard widgets (commit `435edb0`)

**`lib/dashboard/aggregates.ts` — four pure-read helpers:**

- `getProjectsByStatus(scope)` — single `groupBy(status)` aggregate.
  `scope.companyId` is optional; admin/staff pass `{}` for an all-
  companies breakdown, company-role users pass their own id for the
  own-slice view. Zero-fills all 5 `ProjectStatus` keys.
- `getTendersByStatus(scope)` — same shape against `tenders.status`
  with `scope.companyId` interpreted as `publisherCompanyId`. Zero-
  fills all 4 `TenderStatus` keys.
- `getRecentActivityForViewer(limit)` — thin wrapper around
  `listAuditEvents({ limit })`. Role-aware visibility is already
  enforced inside `listAuditEvents`; the wrapper sets the dashboard's
  limit default (10).
- `getTransactionsSummaryThisMonth(now?)` — admin-only (gated via
  the local `requireAdmin` helper). Returns
  `{ countByType, totalPaiseByType, totalPaise, totalCount,
  monthStart, monthEnd }`. Date-bounded to `[month-start, month-end]`
  computed in UTC. `now` is overridable for tests.

All four Zod-validate inputs and return ActionResult-shaped responses.

**Page replacement (`app/dashboard/page.tsx`):**

- Three role-aware layouts:
  - **admin** — KPI strip (4 cards: Total projects, Active, Total
    tenders, Transactions this month) + Projects-by-status +
    Tenders-by-status + per-month transactions summary card + recent
    activity.
  - **staff** — Same as admin minus the per-month transactions card
    AND the transactions KPI tile (transactions are admin-only).
  - **company** — Slimmed KPI strip (Your projects + Active +
    Completed) + Your-projects-by-status card + own-slice recent
    activity.

- KPI tiles, status-breakdown rows, and the activity card are all
  fetched in parallel inside the page render. The recent-activity
  card stays inside a `<Suspense>` so its actor / target name
  resolution doesn't block the KPI strip.

**Four new presentational primitives in `app/dashboard/_components/`:**

- `kpi-stat-card.tsx` — `<KpiStatCard>` with `label / value / hint /
  icon / accent` props. Single-figure card primitive.
- `status-breakdown-card.tsx` — `<StatusBreakdownCard>` rendering one
  row per status, each linked to the corresponding list page with
  the status filter pre-applied. Generic — used by both the projects
  and tenders breakdown cards.
- `recent-activity-card.tsx` — `<RecentActivityCard>` wrapping
  `getRecentActivityForViewer` + `resolveReferences` + the existing
  `<ActivityFeedRow>` primitives. Three render states (error /
  empty / loaded).
- `month-transactions-summary-card.tsx` —
  `<MonthTransactionsSummaryCard>` admin-only. Per-type breakdown
  grid + grand total. Empty-month case ("No transactions recorded
  this month yet.") renders in place of the grid.

**Tests in `lib/dashboard/__tests__/aggregates.test.ts` (+10):**

Fixture: 2 companies (+1 publisher), 5 projects across the 5
statuses (one duplicate `active` under company B), 3 tenders across
draft / published / awarded, 7 transactions: 5 this month +
2 last month.

- `getProjectsByStatus({})` — admin sees the full breakdown (1/2/0/1/1).
- `getProjectsByStatus({ companyId: companyA })` — admin can narrow;
  Acme breakdown matches.
- `getProjectsByStatus({ companyId: companyA })` for company-role
  caller — same shape as admin-with-scope.
- `getProjectsByStatus({ companyId: emptyId })` — zero-fills every
  key.
- `getTendersByStatus({})` — admin sees the full breakdown.
- `getTendersByStatus({ companyId: publisher })` matches the
  publisher's slice; narrowing by a non-publisher returns zeros.
- `getTransactionsSummaryThisMonth(PINNED_NOW)` — only this-month
  rows count; the April rows are excluded; monthStart / monthEnd
  match `2026-05-01` / `2026-05-31`.
- `getTransactionsSummaryThisMonth(SEP_2027)` — zero-fills every key
  for an empty month.
- `getTransactionsSummaryThisMonth` refuses staff caller.
- `getTransactionsSummaryThisMonth` refuses company-role caller.

Total at end of Chunk 1: **419 tests** (was 409).

### Chunk 2 — Per-company financial panel + cross-links (commit `84520d2`)

**`lib/transactions/rollups.ts` — one new helper:**

- `getCompanyRecentTransactions(companyId, limit = 5)` — admin-only.
  Latest N transactions for a company, ordered `occurredOn DESC`.
  Mirrors `getProjectRecentTransactions` exactly but scoped to a
  company AND including no-project rows (matching `getCompanyRollup`'s
  own semantics — everything the company is party to).

**Per-company financial panel surface:**

- `app/dashboard/companies/[id]/_components/company-financial-panel.tsx`
  — Server Component. Calls `getCompanyRollup(companyId)` +
  `getCompanyRecentTransactions(companyId, 5)` in parallel. Renders
  the per-type breakdown grid (5 cells) + grand-total line +
  "Recent transactions" mini-list (latest 5 linked to detail) +
  "View all" link to `/dashboard/transactions?companyId=<id>`.
  Mirrors `project-rollup-card.tsx` line-for-line.
- `app/dashboard/companies/[id]/page.tsx` — mounted between the
  overview card and the documents section, **render-gated on
  `session.role === "admin"`**. Staff and company-role viewers don't
  see the panel at all (transactions are admin-only forever).

**Rollup banner on the transactions list page:**

- `app/dashboard/transactions/_components/company-rollup-banner.tsx`
  — Server Component. Mounted ONLY when the URL has `?companyId=<id>`.
  Renders a tight horizontal strip above the table with the grand
  total + 5 per-type figures + the resolved company name. The
  companies list (already loaded by the page for the filter dropdown)
  is reused for the name lookup — no separate query.
- `app/dashboard/transactions/page.tsx` — added the conditional
  banner mount.

**Day-17 followup #7 — `metadata.typeChange` on `updateTransaction`:**

- `lib/transactions/actions.ts` — when the patch changes `type`, the
  audit row picks up `metadata.typeChange = { from, to }`. Mirrors
  the `metadata.statusChange` convention on the tender / project
  transition actions. One extra metadata branch in the audit write;
  no schema change.

**Tests:**

- `lib/transactions/__tests__/rollups-and-csv.test.ts` (+3) —
  `getCompanyRecentTransactions` sort DESC, includes the no-project
  row, refuses non-admin.
- `lib/transactions/__tests__/actions.test.ts` (+2) —
  `metadata.typeChange` captured on a type-change update, no
  `typeChange` field present on a notes-only update.

Total at end of Chunk 2: **424 tests** (was 419).

### Chunk 3 — Projects CSV export + small polish (commit `431ed5e`)

**`lib/projects/csv.ts` — pure helper:**

- `projectsToCsv(rows, lookups)` — RFC-4180 escape, UTF-8 BOM, CRLF
  line endings. Columns: Name, Status, Company, Start, End, Budget,
  Tender, Created at. Budget is rendered as a plain whole-rupees
  integer with no thousands separators and no glyph (matching the
  schema's rupees-only regime; distinct from the transactions
  exporter's decimal-rupees-with-paise form).
- `formatTenderRef(tenderId)` — truncates the uuid to its first 8
  chars + ellipsis so the column doesn't blow out. NULL → empty cell.
- `projectsCsvFilenameDateStamp(now?)` — YYYY-MM-DD stamp for the
  `Content-Disposition` filename.

**`app/dashboard/projects/export/route.ts` — admin/staff GET:**

- 1000-row hard cap (matches the transactions exporter).
- Forwards `status` / `companyId` / `search` from the list page.
- Company-role users → 403 (own listing is for triage, not bulk
  sharing). Unauthenticated → 401.
- Builds the company-name lookup in one IN-query.

**Projects list page — Export button wired in:**

- `app/dashboard/projects/page.tsx` — "Export CSV" button in the
  PageHeader actions, visible only when `canCreate` (admin/staff).
  Mirrors the transactions list's button shape. Forwards the URL's
  current filter params through.
- `buildExportHref` helper localised to the page (paralleling the
  transactions list's localised helper) — same precedent as
  Day-17's "two implementations is fine; the third is when
  abstraction earns its keep".

**`<EmptyState>` primitive (`components/ui/empty-state.tsx`):**

- Reusable empty-pane: icon disc + title + optional description +
  optional action. Same visual language as `<ActivityFeedEmpty>`.
- **Intentionally NOT refactoring the five existing call sites this
  session.** Companies table empty + tenders table empty + projects
  table empty + transactions table empty + audit feed empty all
  have their own bespoke shells; sweeping them onto the primitive
  is its own cleanup pass — touching five files for that in one
  chunk would bury the rest of the work.

**Audit resolver re-verify (`lib/audit/resolve-targets.ts`):**

- The `case "project"` branch resolves to `projectNameById.get(targetId)`
  and `targetHref` routes to `/dashboard/projects/<id>`. Day-17 wired
  this cleanly; **no code change needed** this session — re-read to
  confirm.

**Tests in `lib/projects/__tests__/csv.test.ts` (+8):**

- Header row + BOM + CRLF + standard cell formatting.
- RFC-4180 escape on commas + double quotes (company name with
  comma, project name with both an embedded quote and a comma).
- NULL handling on all four nullable columns (tenderId / startDate /
  endDate / budgetInr) — five consecutive empty trailing cells
  before `createdAt`.
- Budget rendered as plain rupees-integer (`50000000`,
  `12345`) — no thousands separators, no glyph, no `.00`
  paise tail.
- TenderId truncated to `01234567...` form; full uuid does not
  appear.
- Missing-company-lookup row produces an empty Company cell, rest
  of row well-formed.
- `projectsCsvFilenameDateStamp` returns YYYY-MM-DD for a given
  Date and defaults to today.

Total at end of Chunk 3: **432 tests** (was 424).

## Key decisions

**Dashboard widgets over a Reports module this session.** Reports
proper (Day 19/20) needs a fresh design pass — PDF generation,
period selection, export-to-disk semantics. Dashboard widgets are a
smaller-blast-radius pivot: they reuse Day-17's rollup helpers as-
is and put the existing data in front of the user. When Reports
proper lands, its first card is probably a date-range version of
these same widgets.

**Aggregates module trusts the caller's scope arg.** The dashboard
page is the one deciding whether the viewer sees the all-companies
breakdown or the own-slice. Pushing that decision down into the
aggregate helper would couple it to `session.role` and force every
future consumer (a future "executive dashboard" with totally
different scoping rules, e.g.) to pretend to be one of the three
roles. Keeping the helper scope-agnostic + Zod-validated is the
right primitive.

**`getTransactionsSummaryThisMonth` admin-only, function-level
gate.** Mirrors every other surface in the transactions module.
Even though the dashboard page already gates the card on `isAdmin`,
the helper enforces it too — defence in depth, and prevents a
future consumer from accidentally rendering the figure for a non-
admin viewer.

**Month boundary in UTC.** The `occurredOn` column is date-only and
timezone-agnostic in storage, but the month-start string the helper
computes IS dependent on the runtime's timezone if derived via
`new Date()`. Using UTC keeps the boundary deterministic across
deployments. The test pins a known month via the `now` arg so it
isn't flaky around month rollovers.

**Per-company panel on the company detail page (not a separate
`/financials` route).** The panel benefits from the existing access-
control gate on the detail page (`getCompany` already row-scopes
company-role users). A separate route would have to re-implement
those checks. When/if we want a date-bounded company financials
page, it can land as a new route — but the at-a-glance need is
covered by the panel inline.

**Per-company panel admin-only, render-gated.** Same precedent as
the Day-17 per-project rollup card. The company detail page is
visible to admin/staff/company-role (within the right row scope);
the financial panel additionally requires `role === "admin"`. Even
staff users on the company detail page don't see the panel —
transactions are admin-only forever.

**`getCompanyRecentTransactions` includes the no-project rows.**
Matches `getCompanyRollup`'s own semantics — "everything the
company is party to, regardless of project". The recent-list on the
panel should reflect the same scope as the rollup totals above it;
omitting no-project rows would produce a mismatched "totals minus
office rent" view.

**Transactions list rollup banner conditional on `companyId`.** An
unfiltered banner wouldn't summarise anything coherent — totals
across every company don't pivot a decision. The banner shows up
only when the filter narrows to one company, where the totals are
meaningful. Multi-company filters (no `companyId` set, or `companyId`
empty) skip the banner cleanly.

**`metadata.typeChange` on `updateTransaction`, not a new audit
verb.** Mirrors `metadata.statusChange` on
`transitionTenderStatus` / `transitionProjectStatus`. A new
`transaction_type_changed` verb would partially duplicate `updated`
and require careful migration of the existing audit reader code.
The metadata field is a much lighter touch and keeps forensic
queries cheap (one JSON-walk against the existing `updated` rows).

**Projects CSV: rupees-only, no paise tail.** Distinct from the
transactions CSV's decimal-rupees-with-paise form. The schema
distinction is real — `projects.budgetInr` is whole rupees,
`transactions.amountPaise` is integer paise. Don't paper over the
two precision regimes by adding `.00` tails to all rupee figures;
the CSV mirrors the column shape.

**Projects CSV company-role refusal.** The export is admin/staff
only — a company-role user already has the projects list scoped to
their own row, and bulk-exporting their own row isn't a Phase-1
need. Company-role gets 403 from the route handler. If the use
case emerges, a follow-up can widen the gate.

**`<EmptyState>` not retrofitted to existing call sites.** Five
existing usages (each with subtle copy and action differences) are
their own cleanup pass; mixing the visual lift in with the
dashboard work would bury the rest of the diff under five small
file edits. Primitive lands now so the dashboard widgets and any
future surface have it available; the refactor of existing call
sites is a separate session.

**No abstraction lift for `*ToCsv` helpers at the two-occurrence
mark.** Transactions and projects exports have different columns,
different formatting, different cascade rules. The third occurrence
(probably tenders, Day 19/20) is when a shared `lib/csv.ts` helper
earns its keep — until then duplication is the right shape.

## Gotchas surfaced

**`Promise.resolve({ ok: true as const, byStatus: ... })` is
needed to type-narrow the company-role branch.** Without
`as const` on `ok`, the discriminant flattens to `boolean` and the
downstream check loses the narrowing. Same trick that
`lib/types/action-result.ts` documents for its own discriminated
union.

**`getTendersByStatus` for company-role would be wasted work.**
Companies don't publish tenders today, and even if they did, the
dashboard wouldn't render the tenders card for them per the brief.
The branch sidesteps the query entirely with a `Promise.resolve`
that satisfies the same type — avoids both the DB hit and any
spurious "tender_status" zeroes appearing for a company-role
viewer.

**`Date(Date.UTC(year, month + 1, 0))` is the last day of THIS
month** (because day 0 of month+1 = last day of month). Standard
trick but worth flagging: anyone editing `currentMonthBoundsUtc`
who tries `Date.UTC(year, month, 31)` to "be more explicit" will
get a wrong answer on February / April / June / September /
November.

**The transactions list page's `companyOptions` ALREADY lists every
company.** The rollup banner doesn't need to query for the name
itself — pass the pre-resolved name as a prop. Saves an IN-query
on every filtered-by-company page render.

**`Project.tenderId` is NULLABLE.** The CSV's `formatTenderRef`
function has to handle NULL → empty cell explicitly. The schema's
ON DELETE SET NULL cascade for `projects.tenderId` means we WILL
see NULL values in production once tenders start getting deleted
(which is Phase-1-rare but not impossible).

**Page-level `Promise.resolve(null)` for non-admin in the
dashboard's parallel fetch.** The conditional `Promise.all`
shape with `isAdmin ? real : Promise.resolve(null)` is the cleanest
way to keep the array's element-position-to-meaning contract
stable while making one of the three slots conditional. The
downstream `txMonthResult && txMonthResult.ok` narrow then handles
both the "non-admin caller" case (null) and the "admin caller, but
helper refused" case (`{ ok: false }`) uniformly.

## Surfaces touched

```
# Chunk 1 — Admin dashboard widgets (commit 435edb0)
app/dashboard/_components/kpi-stat-card.tsx                       (new — KPI tile primitive)
app/dashboard/_components/month-transactions-summary-card.tsx     (new — admin-only per-month summary)
app/dashboard/_components/recent-activity-card.tsx                (new — refreshed activity feed)
app/dashboard/_components/status-breakdown-card.tsx               (new — projects / tenders breakdown)
app/dashboard/page.tsx                                            (modified — replaced placeholder)
lib/dashboard/__tests__/aggregates.test.ts                        (new — 10 tests)
lib/dashboard/aggregates.ts                                       (new — 4 read helpers)

# Chunk 2 — Per-company panel + cross-links (commit 84520d2)
app/dashboard/companies/[id]/_components/company-financial-panel.tsx  (new — admin-only panel)
app/dashboard/companies/[id]/page.tsx                              (modified — mount panel for admin)
app/dashboard/transactions/_components/company-rollup-banner.tsx   (new — banner above table)
app/dashboard/transactions/page.tsx                                (modified — mount banner conditional on companyId)
lib/transactions/__tests__/actions.test.ts                         (modified — +2 tests for metadata.typeChange)
lib/transactions/__tests__/rollups-and-csv.test.ts                 (modified — +3 tests for getCompanyRecentTransactions)
lib/transactions/actions.ts                                        (modified — metadata.typeChange on updateTransaction)
lib/transactions/rollups.ts                                        (modified — getCompanyRecentTransactions)

# Chunk 3 — Projects CSV export + polish (commit 431ed5e)
app/dashboard/projects/export/route.ts                             (new — admin/staff CSV export)
app/dashboard/projects/page.tsx                                    (modified — Export CSV button + helper)
components/ui/empty-state.tsx                                      (new — shared empty-pane primitive)
lib/projects/__tests__/csv.test.ts                                 (new — 8 tests)
lib/projects/csv.ts                                                (new — projectsToCsv helper)

# Day 18 report (this commit)
docs/reports/day-18-report.md                                      (new)
```

## Test totals

Before this session: **409 tests across 20 files**, all green (Day 17
end state).

After this session: **432 tests across 22 files**, all green every
run. Net: **+23**.

Breakdown of the delta:

- +10: `lib/dashboard/__tests__/aggregates.test.ts` (Chunk 1)
- +3:  `lib/transactions/__tests__/rollups-and-csv.test.ts` (Chunk 2)
- +2:  `lib/transactions/__tests__/actions.test.ts` (Chunk 2)
- +8:  `lib/projects/__tests__/csv.test.ts` (Chunk 3)

The brief budgeted ~20–28 new tests; landed at +23 — right in the
middle of the range. No existing test files outside the +2/+3
extensions needed editing; the audit resolver verify was a re-read,
not a code change.

## Followups for Day 19+

**From this session:**

1. **Sweep existing empty-state usages onto `<EmptyState>`.** Five
   surfaces (companies / tenders / projects / transactions tables +
   audit feed) currently have their own bespoke empty panes. The
   primitive landed this session for new consumers; refactoring
   the existing five into it is a small cleanup pass — keep it for
   its own commit so the diff stays focused.
2. **Dashboard widget loading skeletons.** Today the page renders
   inline (the aggregates are cheap), so there's no skeleton between
   layout and content. When the table grows / when the page lands
   on a slower link, lifting the projects + tenders breakdown into
   their own `<Suspense>` boundaries with skeleton fallbacks would
   smooth the first-paint. The activity card already has its
   own Suspense.
3. **Activity-feed.tsx + activity-feed-loading.tsx legacy dead
   code.** `app/dashboard/_components/activity-feed.tsx` and its
   loading shell are no longer used now that
   `<RecentActivityCard>` replaces the call site. Leaving them in
   place this session per the autonomous-mode permission scope
   (file deletion is out of scope); delete in a small followup.
4. **Reports module proper.** Date-range filtered version of the
   dashboard widgets + PDF export. The brief's Day 19/20 window.
   The widget primitives this session lands (KpiStatCard,
   StatusBreakdownCard) are reusable.
5. **Searchable typeahead selects on the project / transaction
   forms.** Phase-1 scale (<200 companies, <200 projects) the
   full dropdowns work fine. Same followup that Day-17 carried.
6. **Per-tender CSV export.** Same shape as Day-17 transactions
   and this session's projects exports — when it lands, that's the
   third occurrence and the right moment to lift a shared
   `lib/csv.ts` helper.
7. **Documents-list CSV export.** Separate session — the file-size
   column is paise-like in its own way and needs a small design
   pass on what columns to include.
8. **Bulk CSV import.** Inverse of the export. Trivial parser given
   the export shape, but the cross-FK invariants + uniqueness
   constraints mean it deserves its own design pass (partial-batch
   failure handling, audit semantics for bulk events).

**Carried forward from Day 17 (unchanged):**

9. **`deleteProject` action.** Needs its own confirm flow + R2-
   cleanup story + soft-delete-vs-hard-delete design pass.
   Deliberately deferred. Note: the transactions cascade is
   RESTRICT, so a project with any transactions can't be deleted
   even if the action existed today — clean by construction.
10. **Project-attached documents.** Schema doesn't currently link
    documents to projects. Separate session.
11. **Side-by-side detail view at desktop widths.** Project /
    transaction / company detail pages would all benefit from a
    3-column layout on `xl:` widths.
12. **`TransactionTypeBadge` and `ProjectStatusBadge` share a
    palette pattern.** No abstraction yet (per the Day-16
    precedent), but as more domains land it may pay to lift a
    `<DomainBadge config={...}>` primitive. Premature today.
13. **`updateTransaction` audit `typeChange` only — `companyId`
    not patchable.** companyId-change correction goes via delete +
    recreate. Followup if/when in-place re-tag becomes a real
    workflow need.

**Carried forward from Day 16 / 15 (unchanged):**

14. **Session invalidation on password reset.** Phase-3 hardening.
15. **Multi-step registration UX.** Wizard UI for `/register`.
16. **CAPTCHA / rate limiting** on `/register`, `/forgot-password`,
    token-consume endpoints.
17. **Public tender browsing.**
18. **Token cleanup cron.**
19. **Hoist `escapeHtml` to a shared helper.**
20. **`@opennextjs/cloudflare` install + `open-next.config.ts`.**
21. **D1-backed Drizzle client factory.**
22. **Resend domain verification + production secret.**
23. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
24. **Seed self-healing on changed fixtures.**
25. **Stage real fixtures into R2.**
26. **`docs/05-database-schema.md` rebaseline.** Day 14 / 15 / 16 /
    17 changes all out of sync. The doc is now five sessions behind
    its schema reflection. Doc-pass session due — `companies.annualTurnover`,
    the two token tables, `projects`, `transactions` all need
    entries. Recommend scheduling for Day 19 or Day 20.

**Already-resolved this session:**

- Day-17 followup #1 (per-company rollup card on the company detail
  page) — landed in Chunk 2.
- Day-17 followup #6 (transaction history widget on the admin
  dashboard) — `<RecentActivityCard>` covers it via the existing
  cross-platform audit feed; transactions show up alongside every
  other audit event.
- Day-17 followup #7 (`metadata.typeChange` on `updateTransaction`)
  — landed in Chunk 2.
- Day-16 followup (projects CSV export) — landed in Chunk 3.

## Carry-forward to Day 19

- **`dev` ended at 3 commits past Day-17's report commit
  (`d9b83e3`)**: `435edb0` / `84520d2` / `431ed5e` plus this
  report's commit. Run `git log origin/dev..dev --oneline` for
  the up-to-date set — pushing still requires explicit approval
  per `<permissions>`.
- **432 tests passing on every run.** Two new test files added
  (Chunks 1 and 3 each got their own); one existing file picked up
  +5 tests (Chunk 2's rollups-and-csv + actions extensions). No
  flakes.
- **Schema stays at migration 0012.** No new migration this session.
  Per the autonomous-mode scope: surfaces on top of the existing
  schema only.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` — expected Day-12 dedup row.
- **`pnpm cron:pending-cleanup`** clean.
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 18 didn't
  add new emails.
- **`PASSWORD_PEPPER`** unchanged.
- **`getCompanyRecentTransactions` lands alongside the existing
  `getProjectRecentTransactions`** — both used by their respective
  rollup cards. The pattern of "rollup + recent" pairs is now
  established and easy to extend (e.g. per-tender if/when needed).
- **Dashboard is now the single landing page** for the three
  roles. The placeholder it replaces was last touched in Day 7
  (activity feed widget); the welcome card + dev-only session dump
  is now gone (the session email lives in the page subtitle).
- **`<EmptyState>` is available but unwired.** New consumers reach
  for it; existing call sites stay as they were for the cleanup
  pass.
- **The audit-row resolver project + transaction cases were both
  re-verified this session.** No code change needed; Day 17 wired
  them cleanly. The dashboard's recent-activity widget benefits
  automatically.
- **Transactions list rollup banner mounts ONLY on
  `?companyId=<id>`.** The companies dropdown on the filter bar
  already exists since Day 17; the banner adds the totals header
  without disturbing the filter UX.

That's Day 18.
