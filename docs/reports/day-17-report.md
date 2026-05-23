# Day 17 — Transactions: admin-only financial ledger

_Date: 2026-05-23_

## Scope

The financial-ledger slice for the Operations Suite. Three deliverable
chunks, each its own commit on `dev`:

1. **Transactions schema + admin-only CRUD actions.** Lands the
   `transactions` table (migration 0012), the Zod schemas, and the
   `createTransaction` / `updateTransaction` / `deleteTransaction` /
   `getTransaction` / `listTransactions` actions — all gated to admin
   only at the action layer.
2. **List page + filters + form.** Admin-only `/dashboard/transactions`
   surface mirroring the projects list pattern; type / company /
   project / date-range filters; the shared `<TransactionForm>` and
   the create page.
3. **Detail page, rollups, CSV export, project panel.** Per-company
   and per-project rollup helpers (single `groupBy(type)` aggregates),
   admin-only CSV export route, transaction detail + edit pages with
   a delete flow that captures a required reason, and the per-project
   rollup card that surfaces on the project detail page for admin
   viewers. Folds in Day-16 followup #2 (per-project + per-
   transaction name resolution in the audit-row resolver).

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 409/409 green every run (was 367; +42 net);
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean
against the dev DB after migration 0012 applied.

## What shipped

### Chunk 1 — Transactions schema + CRUD actions (commit `bfc6314`)

**Schema additions in `lib/db/schema.ts`:**

- New `TransactionType` union — `invoice | payment | expense |
  advance | refund`. Closed five-value set per docs/03 § Day 19.
- New `transactions` table — `id` (UUID v7), `type` (TEXT with
  `$type<TransactionType>` narrowing), `amountPaise` (**INTEGER
  paise**, never REAL — the load-bearing money convention),
  `currency` (TEXT, default `'INR'`, action-layer Zod-refined to
  literal `'INR'` only), `companyId` (FK → companies.id ON DELETE
  RESTRICT), `projectId` (NULLABLE FK → projects.id ON DELETE
  RESTRICT — both directions deliberate), `occurredOn` (TEXT
  NOT NULL ISO date — business date, distinct from `createdAt`),
  `referenceNumber` (TEXT NULL-distinct UNIQUE — same shape as
  `tenders.referenceNumber`), `notes`, `internalNotes`, standard
  `createdAt` / `updatedAt`.
- Indexes: `companyId`, `projectId`, `type`, `occurredOn`, plus
  `(companyId, type)` and `(projectId, type)` composites for the
  rollup queries.

**Migration `drizzle/0012_gorgeous_whirlwind.sql`:**

Clean CREATE TABLE — both FK cascade clauses preserved by drizzle-kit.
Applied locally via `pnpm db:migrate`; no remote DB touched.

**`lib/transactions/schemas.ts`:**

- `transactionTypeSchema` — closed Zod enum mirroring the type union.
- `createTransactionSchema` — type required, amountPaise positive
  integer, currency optional defaulting to `'INR'` and refined to
  literal `'INR'`, companyId required, projectId optional, occurredOn
  required, referenceNumber + notes + internalNotes optional.
- `updateTransactionSchema` — patch shape; excludes `companyId`
  (once recorded, the counterparty doesn't move).
- `listTransactionsQuerySchema` — type / companyId / projectId /
  occurredOnFrom / occurredOnTo filters + standard pagination + sort
  on `occurredOn` / `amountPaise` / timestamps. Default sort is
  `occurredOn DESC`.
- `transactionIdSchema` — single-id route param validation.

**`lib/transactions/actions.ts`:**

- `createTransaction(input)` — admin only via `requireAdmin`.
  Validates input, soft-checks the companyId exists, then (when
  projectId set) soft-checks the project AND enforces the cross-FK
  invariant (`project.companyId === transaction.companyId`). Insert
  + audit `created` event on `targetType: "transaction"`. Metadata
  captures `companyId` / `projectId` / `type` / `amountPaise`.
- `updateTransaction` — admin only. Field-by-field patch shape; the
  cross-FK invariant is re-checked against the merged row state when
  `projectId` changes.
- `deleteTransaction` — admin only. Delete-with-returning-snapshot
  pattern from `deleteCompany`. Full pre-deletion row in the audit
  row's `before` payload. Accepts an optional `{ reason }` that
  lands under `metadata.reason`.
- `getTransaction` — admin-only read.
- `listTransactions` — admin only. Date-range filter on `occurredOn`
  is inclusive on both ends. No free-text search exposed.

**Tests in `lib/transactions/__tests__/actions.test.ts` (+20):**

- createTransaction happy path (with project + without — the company-
  level expense case)
- companyId-not-found friendly error
- projectId-not-found friendly error
- cross-FK invariant refusal (Acme transaction on BuildRight's
  project)
- RBAC: staff refused, company refused, unauthenticated refused
- Zod: `amountPaise <= 0` refused, `currency !== 'INR'` refused
- updateTransaction happy path with before/after audit snapshot
- updateTransaction cross-FK invariant on patched projectId
- deleteTransaction happy path + full-row snapshot + metadata.reason
- deleteTransaction non-admin refused
- getTransaction admin sees row + non-admin refused
- listTransactions smoke: filter by type, filter by date range
  (inclusive), non-admin refused

Total at end of Chunk 1: **387 tests** (was 367).

### Chunk 2 — List page + filters + form (commit `600afad`)

**Surfaces:**

- `app/dashboard/transactions/page.tsx` — Server Component shell.
  **Hard admin-only auth gate** at the page level: staff and
  company-role users both redirect to `/dashboard`. Fetches
  companies + projects in parallel with the params, mounts the
  filters bar + table-section + Suspense + page-header actions
  (export CSV + add transaction). Sidebar nav already had the
  Transactions entry (Day 4 forward-looking).
- `_components/transactions-filters-bar.tsx` — Client Component
  mirroring the projects filter bar. Type / company / project /
  occurredOn-from / occurredOn-to. The dependent project select
  narrows by selected company AND clears any incompatible
  selection when the company changes — both via the change
  handler and via a defensive `useEffect` for URLs that arrive in
  an inconsistent state.
- `_components/transactions-table.tsx` — pure presentation. Columns:
  Date, Type (badge), Amount (mono right-aligned, formatted via
  `formatRupeesFromPaise`), Company, Project (linked when set, em-
  dash when null), Reference (mono small), Actions (view + edit).
  Empty state copy.
- `_components/transactions-table-section.tsx` — async fetching half;
  pre-fetches the company-name and project-name maps in two indexed
  IN-queries.
- `_components/badges.tsx` — `<TransactionTypeBadge>` with one config
  per type (invoice / payment / expense / advance / refund).
  Exports `TRANSACTION_TYPE_OPTIONS` so the filter bar and form's
  type select stay in sync.
- `app/dashboard/transactions/new/page.tsx` — admin-only create
  shell, fetches companies + projects, mounts the form.
- `components/transactions/transaction-form.tsx` — shared between
  create and edit. Sections: Identity (type + amount), Counterparty
  (company + dependent project select), Dates (occurredOn),
  Reference + Notes. Amount input is the new wrinkle — user types
  rupees-and-paise (`"12345.67"`) and the Controller converts to/from
  integer paise via the new `parsePaiseFromRupees` /
  `formatRupeesFromPaise` helpers in `lib/format/inr.ts`. Echo line
  below the input shows the formatted form.

**`lib/format/inr.ts` extension:**

Three new exports for the paise-precision regime:
- `formatRupeesFromPaise(paise)` — `1234567 → "₹ 12,345.67"`.
- `formatRupeesFromPaiseAscii(paise)` — `"Rs.12,345.67"` for CSV /
  audit logs / log lines.
- `parsePaiseFromRupees(rupeesString)` — `"12345.67" → 1234567`, with
  truncation (not rounding) at two decimals.

The existing `formatInr` / `formatInrAscii` stay unchanged — they're
the rupees-only regime for budgets. The format module is the
boundary between the two precision regimes.

**Tests in `lib/transactions/__tests__/list-actions.test.ts` (+10):**

Fixture seeds 2 companies (Acme + BuildRight), 1 project each, 6
transactions across all 5 types + 1 no-project expense.

- Admin sees all 6 rows; staff refused; company-role refused.
- Filter by type narrows correctly.
- Filter by companyId narrows correctly.
- Filter by projectId narrows correctly (excludes the no-project
  expense).
- Date-range filter inclusive on both ends.
- Layered type + company composes correctly.
- Default sort is `occurredOn DESC` — verified.
- Pagination total matches the SQL-side count.

Total at end of Chunk 2: **397 tests** (was 387).

### Chunk 3 — Detail, rollups, CSV, project panel (commit `66e3516`)

**Detail surface:**

- `app/dashboard/transactions/[id]/page.tsx` — admin-only detail
  Server Component. Loads `getTransaction`, the counterparty company,
  and (optionally) the linked project; renders header + overview +
  `<EntityHistory targetType="transaction">`. The EntityHistory
  union widened from 3 to 4 values (`"transaction"` joined Day 16's
  `"project"`).
- `app/dashboard/transactions/[id]/edit/page.tsx` — admin-only edit
  shell + `<TransactionForm initialValues={...} />`.
- `app/dashboard/transactions/[id]/not-found.tsx` — leak-safe
  fallback.
- `_components/transaction-header.tsx` — Client Component. Title
  composes `"{Type} {formatted-amount}"` (matches the audit-row
  label convention). Edit + Delete buttons. Delete wrapped in
  `<ConfirmDialog reasonField="required">` (5-char min, mirrors
  the tender award-retraction pattern) — deletion of a row is a
  higher-stakes correction than editing, so the reason gets
  captured in `metadata.reason`.
- `_components/transaction-overview.tsx` — three cards (Identity,
  Counterparty, Reference & notes). Amount rendered in a large
  mono tabular-num figure.

**Rollups (`lib/transactions/rollups.ts`):**

- `getCompanyRollup(companyId)` — admin-only. Returns `{ byType:
  Record<TransactionType, { count, totalPaise }>, totalPaise,
  totalCount }`. Single `groupBy(type)` aggregate hitting the
  `transactions_company_type_idx` composite. NULL-project rows
  ARE included.
- `getProjectRollup(projectId)` — admin-only. Same shape, scoped
  to a single project; excludes NULL-project rows by construction.
- `getProjectRecentTransactions(projectId, limit)` — admin-only.
  Latest N project rows ordered occurredOn DESC, for the "Recent
  transactions" mini-list on the rollup card.

Both rollups zero-fill the `byType` skeleton so consumers never have
to handle missing keys.

**CSV export (`lib/transactions/csv.ts` + `app/dashboard/transactions/export/route.ts`):**

- `transactionsToCsv(rows, lookups)` — RFC-4180 escape semantics,
  UTF-8 BOM prefix (so Excel-on-Windows opens it as UTF-8), CRLF
  line endings. Columns: Date, Type, Amount, Currency, Company,
  Project, Reference, Notes. Amount is the rupees-with-paise
  decimal form (no thousands separators, no ₹ glyph — spreadsheet
  apps re-format).
- `app/dashboard/transactions/export/route.ts` — admin-only GET
  Route Handler. Forwards the same searchParams the list page
  consumes, calls `listTransactions` with `perPage: 1000` (Phase-1
  cap), builds the company/project lookups in two IN-queries,
  returns the CSV with `Content-Type: text/csv` and
  `Content-Disposition: attachment; filename="transactions-{YYYY-MM-DD}.csv"`.
  Non-admin → 403; unauthenticated → 401.
- Export button wired into the list page's PageHeader actions; it
  forwards the current URL's filter params through to the export.

**Per-project rollup card (`app/dashboard/projects/[id]/_components/project-rollup-card.tsx`):**

- Server Component. Calls `getProjectRollup` + `getProjectRecentTransactions`
  in parallel.
- Renders a per-type breakdown grid (5 cells) + a grand-total line
  + a "Recent transactions" mini-list (latest 5, each linked to
  the transaction detail page) + a "View all" link to
  `/dashboard/transactions?projectId=<id>`.
- Wired into the project detail page between the overview and the
  history sections, **gated on `session.role === "admin"`** — staff
  and company-role viewers don't see the card at all.

**Audit-row resolver (`lib/audit/resolve-targets.ts`):**

Day-16 followup #2 folded in here.

- Batches per-project + per-transaction lookups alongside the
  existing company / tender / application batches (`projectNameById`,
  `transactionLabelById`).
- `case "project"` resolves to the project name; `case "transaction"`
  resolves to a composite label `"{type} {formatRupeesFromPaise} on
  {date}"` — example: `"payment ₹50,000.00 on 2026-05-23"`. The
  composite reads in the activity feed without click-through.
- `targetHref` switch routes `"transaction"` to
  `/dashboard/transactions/<id>` (previously fell into the no-link
  branch). The `"project"` route was already wired Day 16.
- Truncated-id fallback retained for `user` / `document` (no detail
  pages yet).

**Tests in `lib/transactions/__tests__/rollups-and-csv.test.ts` (+12):**

Fixture: Acme with 2 invoices + 3 payments + 1 project-tagged
expense, plus 1 company-level (no-project) expense to exercise the
per-company vs per-project asymmetry.

- `getCompanyRollup` totals all 7 rows including the no-project
  expense; byType / totalCount / totalPaise all correct.
- `getCompanyRollup` non-admin refused.
- `getCompanyRollup` zero-fills byType for an empty company (no
  rows = all-zero totals).
- `getProjectRollup` excludes the no-project expense (6 rows total,
  not 7).
- `getProjectRollup` non-admin refused.
- `getProjectRecentTransactions` returns the latest N rows in
  `occurredOn DESC` order; non-admin refused.
- CSV: header row + BOM + CRLF, correct cell formatting for a
  standard row.
- CSV: RFC-4180 escape for commas + embedded double quotes (notes
  field with both, company name with a comma).
- CSV: paise → decimal rupees formatting without thousands
  separators (`12345_67 → "12345.67"`, `7 → "0.07"`).
- `csvFilenameDateStamp` returns `YYYY-MM-DD` for a given date and
  defaults to today.

Total at end of Chunk 3: **409 tests** (was 397).

## Key decisions

**INTEGER paise vs INTEGER rupees.** Transactions store paise;
projects.budgetInr stores rupees. Two precision regimes intentionally
— budgets are planning figures where 50 paise is noise, transactions
are actuals where 50 paise matters for invoice reconciliation. The
new helpers in `lib/format/inr.ts` are the boundary between the two
— `formatInr` for rupees, `formatRupeesFromPaise` for paise. No
silent conversions in the action layer; the Zod schema rejects
non-integers and the formatter is the only translator.

**Currency column exists in the schema; only `'INR'` is accepted
today.** The column is forward-compat for Phase-3 multi-currency.
The action layer Zod-refines to literal `'INR'` so the only way
through is INR; a future widening is a schema-only change to the
refine clause, no migration. Captured both in the column docstring
and in the `currencySchema` docstring.

**`projectId` is NULLABLE on `transactions`.** Company-level
overheads — office rent, GST filing fees — don't belong to any
project. Forcing every transaction to a project would push the
team to invent a "general overhead" project and the bookkeeping
gets noisier. Tested via the no-project expense fixture row.

**`projectId` cascade is RESTRICT, not SET NULL.** Asymmetric with
`users.companyId` (SET NULL — losing a company orphans a user,
fine). Losing a project under outstanding transactions IS bad —
the transactions exist because of the project; SET NULL would
silently turn project-tagged ledger rows into "company-level"
rows and quietly corrupt the rollup. RESTRICT forces a deliberate
cleanup before deletion. Combined with Day-16's deferred
`deleteProject`, the cascade is academic for now but the invariant
is right.

**Cross-FK invariant (`project.companyId === transaction.companyId`)
enforced at the action layer.** The DB can't express join-key
equality as a constraint, but without it you could record a
transaction "on" Acme's project that's tagged to BuildRight's
company row. Pinned by tests on create AND on patched projectId
(update re-checks against the merged row state).

**Whole module admin-only — enforced at action AND page layers.**
Defence in depth. Every action gates via `requireAdmin`; every
page gates via `session.role !== "admin" → redirect`. The CSV
export route gates via `403`. Sidebar nav stays visible to
everyone per the existing "render everything, let the page gate"
pattern; non-admins clicking through land back at `/dashboard`.

**`updateTransaction` excludes `companyId`.** Once recorded, the
counterparty doesn't move. Correcting a wrong counterparty means
delete + recreate — the audit log can reconstruct the history
from the deletion snapshot + the new `created` event. Cleaner
than trying to define what "moving" a transaction means for
forensic queries.

**`deleteTransaction` requires a reason via ConfirmDialog (5-char
min).** Same shape as `retractAward`. Editing a transaction is
normal; deleting one is rarer and worth capturing context for.
The reason lands in `metadata.reason` on the audit row; the
full pre-deletion snapshot lives in `before`. Test pins both.

**Per-project rollup card admin-only, page-render-gated.** The
project detail page already had separate render paths for
admin/staff/company-role viewers (admin sees internal notes,
etc.). The rollup card layers on top of that — only admin viewers
see it. Staff users on the project detail page do NOT see it,
which is a deliberate "transactions are admin-only forever" gate
even when transactions touch a project staff users can read.

**CSV BOM-prefix + decimal-rupees Amount column.** UTF-8 BOM so
Excel-on-Windows doesn't default to a legacy code page (a common
sharp edge for ₹-containing exports). Amount is plain decimal,
no glyph and no thousands separators — Excel often treats
prefixed-currency cells as TEXT and breaks SUM/AVG, so we ship
the figure as a plain number and let the user format the column.
The Currency column carries the code explicitly.

**Audit-row composite label for transactions.** "transaction
{truncated-id}" reads badly in the activity feed. The composite
`"payment ₹50,000.00 on 2026-05-23"` packs three at-a-glance
facts (type / amount / date) into a single label so the feed is
scannable without click-through. Same forensic-density principle
as the application label (`"Acme's application to {tender}"`)
from Day 6.

**`getProjectRecentTransactions` over reusing `listTransactions`.**
The mini-list on the rollup card wants 5 rows in a specific
column shape (no company name, no notes, etc.). Reusing
`listTransactions` would pull all columns + the count query +
the pagination wrapping for a card that just needs `id / type /
amountPaise / occurredOn / referenceNumber`. The dedicated helper
is cheaper and the rollup module is the natural home.

## Gotchas surfaced

**`currencySchema.optional().default("INR")` narrows the inferred
output type to literal `"INR"`.** Tripped on the form's
`buildEditDefaults` — the row's `currency` is plain `string` from
Drizzle's TEXT column, but the form's `CreateTransactionInput`
expects `"INR"`. Cast at the assignment site with a comment
explaining the bridge. Not a code change at the schema layer —
the literal-narrowing is the intended behaviour for "this field
must be INR or it's a Zod refusal".

**Drizzle's `groupBy` aggregate returns `count` and `sum` as
`number | string` from better-sqlite3.** Defensive `Number(row.x)
|| 0` coerce in both rollup functions. Without it, a SUM result
that comes back as a JS number string (Node's int-vs-bigint
boundary at 2^53 is the typical trigger; not realistic for our
amounts but defensive is cheap) would propagate as a string into
the `byType.totalPaise` field and silently break arithmetic.

**The cross-FK invariant `project.companyId === transaction.companyId`
must be re-checked on update, not just on create.** Easy to forget
— the update action could let a patched projectId sneak through
without re-validating against the merged row state. Pinned by a
test that creates an Acme transaction tagged to Acme's project,
then patches the projectId to BuildRight's project, expecting
refusal.

**Delete-with-returning-snapshot pattern requires `.returning()`
to be called BEFORE the audit write.** Standard pattern from
`deleteCompany` — the row is gone after the DELETE, so the audit
snapshot has to be derived from the returned row. Same shape used
in `deleteTransaction`. Pinned by a test that asserts the audit's
`before` payload carries every column the row had.

**The CSV's UTF-8 BOM is `'﻿'` (one character).** Not the
three raw bytes `0xEF 0xBB 0xBF` — Node + the runtime will encode
the BOM character as those three bytes when the response is sent
with `Content-Type: text/csv; charset=utf-8`. The test verifies
the leading char code is `0xfeff`, not the byte sequence.

**`getProjectRecentTransactions` re-applies the `projectId is not
null` filter even though `eq(transactions.projectId, projectId)`
already excludes NULLs.** Redundant in SQL semantics, but it makes
the query plan obvious to a reader and to future-`EXPLAIN`-output
inspection — the dedicated NULL clause signals intent. Cheap;
the optimiser folds the duplicate.

**Audit resolver `formatRupeesFromPaise` import crosses module
boundaries.** `lib/audit/resolve-targets.ts` now imports from
`lib/format/inr.ts`. Both leaf modules — no upward dependency
on a domain module — so the boundary stays clean. Worth flagging
because the audit module was historically a hard leaf; adding
the format import is the smallest possible step and the
alternative (hand-rolling the formatter in resolve-targets.ts)
would duplicate the rupees-and-paise arithmetic.

## Surfaces touched

```
# Chunk 1 — Schema + CRUD actions (commit bfc6314)
drizzle/0012_gorgeous_whirlwind.sql                                 (new — transactions table)
drizzle/meta/0012_snapshot.json                                     (new — drizzle-kit generated)
drizzle/meta/_journal.json                                          (modified — drizzle-kit generated)
lib/db/schema.ts                                                    (modified — transactions table + TransactionType union)
lib/transactions/__tests__/actions.test.ts                          (new — 20 tests)
lib/transactions/actions.ts                                         (new — CRUD + listTransactions)
lib/transactions/schemas.ts                                         (new — Zod schemas)

# Chunk 2 — List page + filters + form (commit 600afad)
app/dashboard/transactions/_components/badges.tsx                   (new — TransactionTypeBadge + TRANSACTION_TYPE_OPTIONS)
app/dashboard/transactions/_components/transactions-filters-bar.tsx (new — type/company/project/date filters)
app/dashboard/transactions/_components/transactions-table-section.tsx (new — async data half)
app/dashboard/transactions/_components/transactions-table.tsx       (new — presentational table)
app/dashboard/transactions/new/page.tsx                             (new — admin-only create shell)
app/dashboard/transactions/page.tsx                                 (new — admin-only list page)
components/transactions/transaction-form.tsx                        (new — shared form, create + edit)
lib/format/inr.ts                                                   (modified — formatRupeesFromPaise / parsePaiseFromRupees / ASCII variant)
lib/transactions/__tests__/list-actions.test.ts                     (new — 10 tests)

# Chunk 3 — Detail page, rollups, CSV, project panel (commit 66e3516)
app/dashboard/projects/[id]/_components/project-rollup-card.tsx     (new — per-project rollup card, admin-only)
app/dashboard/projects/[id]/page.tsx                                (modified — mount the rollup card for admin viewers)
app/dashboard/transactions/[id]/_components/transaction-header.tsx  (new — Client Component with delete-with-reason)
app/dashboard/transactions/[id]/_components/transaction-overview.tsx (new — three cards)
app/dashboard/transactions/[id]/edit/page.tsx                       (new — admin-only edit shell)
app/dashboard/transactions/[id]/not-found.tsx                       (new — leak-safe fallback)
app/dashboard/transactions/[id]/page.tsx                            (new — admin-only detail page)
app/dashboard/transactions/export/route.ts                          (new — admin-only CSV export)
components/audit/entity-history.tsx                                 (modified — targetType union widened to include "transaction")
lib/audit/resolve-targets.ts                                        (modified — project + transaction name resolution + transaction href)
lib/transactions/__tests__/rollups-and-csv.test.ts                  (new — 12 tests)
lib/transactions/csv.ts                                             (new — RFC-4180 export helper)
lib/transactions/rollups.ts                                         (new — per-company + per-project aggregates + recent N)

# Day 17 report (this commit)
docs/reports/day-17-report.md                                       (new)
```

## Test totals

Before this session: **367 tests across 17 files**, all green (Day 16
end state).

After this session: **409 tests across 20 files**, all green every
run. Net: **+42**.

Breakdown of the delta:

- +20: `lib/transactions/__tests__/actions.test.ts` (Chunk 1)
- +10: `lib/transactions/__tests__/list-actions.test.ts` (Chunk 2)
- +12: `lib/transactions/__tests__/rollups-and-csv.test.ts` (Chunk 3)

The brief budgeted ~34–48 new tests; landed at +42 — right in the
middle of the range. No existing test files needed editing; the
audit resolver change is small enough not to need its own dedicated
test (covered indirectly via the EntityHistory render path on the
transaction + project detail pages).

## Followups for Day 18+

**From this session:**

1. **Per-company rollup card on the company detail page.**
   `getCompanyRollup` shipped this session is unused outside the
   tests — wiring it into a company-detail surface mirrors the
   project rollup card and is a one-component addition.
2. **Searchable company / project selects in `<TransactionForm>`.**
   Phase 1 scale (<200 companies, <200 projects) the full
   dropdowns work fine. When either grows, swap to a typeahead-
   search Server Action — same shape noted for the project and
   tender forms.
3. **Bulk CSV import.** Inverse of the export. Trivial parser
   given the export shape, but the cross-FK invariant + the
   unique-reference-number constraint mean it deserves its own
   design pass (transaction validation, partial-batch failure
   handling, audit semantics for bulk events).
4. **Streaming CSV export.** At 1000 rows the in-memory path is
   fine. The 1000-row cap is encoded in `EXPORT_ROW_CAP` — when
   the table grows past it, swap to a chunked write loop on the
   route handler. The CSV helper is already row-by-row friendly.
5. **`TransactionTypeBadge` and `ProjectStatusBadge` share a
   palette pattern.** No abstraction yet (per the Day-16
   precedent), but as more domains land it may pay to lift a
   `<DomainBadge config={...}>` primitive. Premature today;
   noted for the third occurrence.
6. **Transaction history widget on the admin dashboard.** A
   "most recent N transactions across all companies" card on
   `/dashboard`. Cheap once we land it; not strictly needed for
   Phase 2 completion.
7. **`updateTransaction` doesn't re-key the audit metadata when
   `type` or `companyId` would change.** companyId isn't
   patchable, but type IS — and the original create's
   metadata.type wouldn't update on a type change. Forensic
   queries against `metadata.type` would see the original. Either
   land a dedicated `type_changed` audit verb or capture
   `metadata.typeChange = { from, to }` on update — Day 18
   small-lift candidate.

**Carried forward from Day 16 (unchanged):**

8. **`deleteProject` action.** Needs its own confirm flow + R2-
   cleanup story + soft-delete-vs-hard-delete design pass.
   Deliberately deferred. Note: the transactions cascade is
   RESTRICT, so a project with any transactions can't be deleted
   even if the action existed today — clean by construction.
9. **Project-attached documents.** Schema doesn't currently link
   documents to projects. Separate session.
10. **Side-by-side detail view at desktop widths.** Project and
    transaction detail pages would both benefit from a 3-column
    layout on `xl:` widths.
11. **Project list export-to-CSV.** Same shape as the new
    transactions CSV export — trivial when added.
12. **Project dashboard widget.** "Projects by status" KPI card.

**Carried forward from Day 15 (unchanged):**

13. **Session invalidation on password reset.** Phase-3 hardening.
14. **Multi-step registration UX.** Wizard UI for `/register`.
15. **CAPTCHA / rate limiting** on `/register`, `/forgot-password`,
    token-consume endpoints.
16. **Public tender browsing.**
17. **Token cleanup cron.**
18. **Hoist `escapeHtml` to a shared helper.**
19. **`@opennextjs/cloudflare` install + `open-next.config.ts`.**
20. **D1-backed Drizzle client factory.**
21. **Resend domain verification + production secret.**
22. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
23. **Side-sheet vs side-by-side detail view at desktop widths.**
24. **Seed self-healing on changed fixtures.**
25. **Stage real fixtures into R2.**
26. **drizzle-kit ALTER TABLE ADD COLUMN cascade-clause gotcha.**
    Did NOT surface this session (migration 0012 was CREATE TABLE).
27. **`docs/05-database-schema.md` rebaseline.** Day 14 / 15 / 16 /
    17 changes all out of sync. The doc is now four sessions
    behind on its schema reflection. Doc-pass session due —
    `companies.annualTurnover`, the two token tables, `projects`,
    and `transactions` all need entries.

**Already-resolved this session:**

- The Day-16 followup #2 (`projectNameById` resolution in the
  audit resolver). Plus a free bonus: `transactionLabelById` lands
  in the same shape.
- The `AuditTargetType: "transaction"` declared Day 6 finally has
  callers writing rows under it; the resolver now renders them
  with a meaningful composite label instead of a placeholder.

## Carry-forward to Day 18

- **`dev` ended at 4 commits past Day 16's report commit**
  (`53f2d85`): `bfc6314` / `600afad` / `66e3516` plus this report's
  commit. Run `git log origin/dev..dev --oneline` for the up-to-
  date set — pushing still requires explicit approval per
  `<permissions>`.
- **409 tests passing on every run.** Three new test files added
  (Chunks 1, 2, 3 each got their own). No existing test files
  edited; no flakes.
- **Migration 0012 applied to dev DB.** `transactions` table
  present. `pnpm db:reset` would rebuild from scratch via the
  migrations chain.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` — expected Day-12 dedup row.
- **`pnpm cron:pending-cleanup`** clean.
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 17 didn't
  add new emails.
- **`PASSWORD_PEPPER`** unchanged.
- **In-memory test substrate** picks up migration 0012 via the
  vitest setup; new tests get a fresh per-worker `:memory:` DB
  with the full schema.
- **The audit-row resolver now resolves project + transaction
  labels**, with the project detail page's history feed and the
  new transaction detail page's history feed both surfacing
  human-readable target labels.
- **Transactions are admin-only forever.** Sidebar entry stays
  visible to everyone (existing "render everything, let the
  page gate" pattern); non-admins clicking through redirect to
  `/dashboard`.

That's Day 17.
