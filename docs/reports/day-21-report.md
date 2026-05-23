# Day 21 — UAT seed fixture buildout + token cleanup cron + seed self-healing

_Date: 2026-05-23_

## Scope

Three deliverable chunks executing `docs/seed-plan.md` end-to-end. No
schema migration, no new dependencies — the seed lift sits entirely on
the existing Day-19 migration 0012 baseline. Each chunk is its own
commit on `dev`:

1. **Phase-1 fixture extension.** Two new client companies (Vertex +
   Nimbus) covering the missing `expired` complianceStatus and the
   high-/low-annualTurnover axis; second staff user; second + third
   company-role users (incl. an unverified one + an inactive one); a
   verified GST with `< 7 days` expiry so the expiry-sweep cron has a
   fresh T-7 row to surface.
2. **Phase-2 + Phase-3 fixtures + token-cleanup cron.** 6 tenders (one
   per `TenderStatus` plus the over-the-line + msmeOnly variants); 9
   tender applications (one per `TenderApplicationStatus`); 6 projects
   (one per `ProjectStatus`, one promoted from the awarded tender + with
   overdue endDate); 20 transactions (4 per `TransactionType`, cross-FK
   invariant strictly enforced, spread across May/Apr/Mar 2026). Plus a
   new `cleanupExpiredTokens` helper + `cron-token-cleanup` script +
   wrangler cron trigger + 4 tests.
3. **Seed self-healing.** Replaces the "skip on exists" contract with
   compare-and-update on a documented per-entity safe-to-update set.
   Frozen primary keys / natural keys / FKs / audit timestamps stay
   frozen. Three states now: `inserted` / `updated` / `unchanged`.
   8 new tests pin the contract.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 482/482 green (was 470; +12 net);
`pnpm db:seed` against the existing DB → every row logged as `unchanged`
(idempotency holds); `pnpm cron:expiry-sweep` now reports
`remindersAttempted=1` (Vertex's new T-7 row, was 0 in Day 20);
`pnpm cron:pending-cleanup` clean; `pnpm cron:token-cleanup` clean on
both first and second runs.

`pnpm db:reset` deferred — Mayuresh's `pnpm dev` server is holding the
SQLite file open (EBUSY on the unlink). The self-healing test file
exercises the reset → migrate → seed shape end-to-end via the
per-worker in-memory DB; full unit coverage on the contract. Manual
dashboard verification also deferred per the same blocker.

## What shipped

### Chunk 1 — Phase-1 fixture extension (commit `823c73c`)

**Companies.** Two new standalones added to `STANDALONE_COMPANIES`:

- **Vertex Power Systems** — Solar EPC, Jaipur, complianceStatus
  `expired`, non-MSME, `annualTurnover` set deliberately LOW
  (₹2 crore). Pairs with an expired trade-license document fixture
  explaining the `expired` state. Gated out of every realistically-
  sized tender by the Chunk-2 turnover gate.
- **Nimbus Infraworks** — Infrastructure, Gurugram, complianceStatus
  `compliant`, non-MSME, `annualTurnover` set HIGH (₹100 crore).
  Clears every reasonably-sized tender minimum, including the Chunk-2
  Coastal Road tender's ₹50 cr gate. The winning bidder on the
  awarded tender, and the company on the Phase-3 promoted project.

Together with the existing 5 standalones + 2 JVs, this covers all 4
`ComplianceStatus` values (`pending` / `compliant` / `non_compliant` /
`expired`) and gives the apply-to-tender turnover gate one company
that clears any bar and one that fails it.

**Companion seed-helper fix:** the standalone-company INSERT was
silently dropping `annualTurnover` from the spec. Added one line so
the column actually lands.

**Users.** Three new entries in `SEED_COMPANY_USERS` + one in
`SEED_STAFF_USERS`:

- `staff2@consultway.local` — second staff user, verified, active.
  Gives role-collision tests a peer.
- `buildright@example.local` — company-role on BuildRight, verified.
- `greentech@example.local` — company-role on GreenTech, **`emailVerifiedAt = null`**.
  Exercises the un-verified login gate + the resend-verification
  affordance without anyone having to register a fresh account.
- `inactive@example.local` — company-role on Nimbus,
  **`isActive = false`**. Exercises the deactivated-account UI.

**Documents.** 5 new rows across the 2 new companies. The seed now
covers all 5 `DocumentStatus` values (`pending` was the last missing
state, the pre-confirm upload slot):

- Vertex Power Systems — 2 rows: a **verified GST with
  `expiresInDays = 5`** (the T-7 reminder row the cron surfaces) and
  an **expired trade license** explaining why Vertex's compliance is
  `expired`.
- Nimbus Infraworks — 3 rows: a **`pending` GST** (the pre-confirm
  state, the slot that's missing from every other company's
  fixtures) + a verified PAN + a verified CoI.

**Smoke checks:**

- `pnpm db:seed` against the existing DB → 6 core rows + 5 documents
  inserted; everything else `skipped`. Re-run → fully `skipped`.
- `pnpm cron:expiry-sweep` → `remindersAttempted` went from 0 → 1
  (Vertex GST, 5 days to expiry, T-7 slot). `remindersSkippedDeduped`
  stayed at 1 (Day-12 Acme trade_license T-30 already in the
  dedup table).

Total at end of Chunk 1: **470 tests** (unchanged — no test code, just
fixture data).

### Chunk 2 — Phase-2 + Phase-3 fixtures + token-cleanup cron (commit `378f049`)

**Tenders (6).** One per `TenderStatus`:

- `draft` — CW-2026-DRAFT-001. No publishing dates, no eligibility,
  no winner. Pre-publish state.
- `published` ×3 covering the long-tail variants:
  - **CW-2026-MSME-SOLAR-002** — `msmeOnly: true`, no turnover gate,
    open now (only BuildRight qualifies).
  - **CW-2026-INFRA-COASTAL-003** — `eligibleSector + eligibleGeography`
    set, `minAnnualTurnoverInr = ₹50 cr` (only Nimbus clears every
    gate).
  - **CW-2026-CIVIL-004** — `closingDate` 5 days past, status still
    `published`. The over-the-line state UI renders as "closed via
    deadline" rather than via the explicit status flip.
- `closed` — CW-2026-ROADS-005. Staff explicitly closed the window
  pending board evaluation.
- `awarded` — CW-2026-SOLAR-006. Terminal state, `awardedCompanyId`
  populated against Nimbus (the winning bidder), `awardedCompanyName`
  passed through as a name in the seed spec and resolved to id at
  insert time (same pattern as JV partner name → id resolution).

**Tender applications (9).** One per `TenderApplicationStatus`:

- `submitted` — BuildRight → MSME Solar (qualifies, awaiting decision).
- `shortlisted` — Nimbus → Coastal Road (cleared every gate); Nimbus
  → Highway PMC; Nimbus → Andhra Solar (the awarded tender's winner,
  the state-machine precondition to the award).
- `rejected` — Acme-BuildRight JV → MSME Solar (JV isn't MSME-flagged,
  only the partner is); Acme → Coastal Road (no stated turnover); Acme
  → Highway PMC (same gap).
- `withdrawn` — GreenTech → Andhra Solar (pulled the application
  after their internal compliance review surfaced gaps).

Nimbus has 3 applications across 3 tenders so the per-company
applications list has multiple rows. The awarded tender's winning
company has a `shortlisted` application as the state-machine
precondition to the award — important because the application-list UI
shows "this row was shortlisted before being awarded".

**Projects (6).** One per `ProjectStatus`:

- `planning` — Acme's Mumbai Coastal Stretch Survey (dates in future).
- `active` — BuildRight's Bengaluru Trunk Sewer PMC (in-flight today).
- `on_hold` — GreenTech's Tamil Nadu Solar Park (paused for grid
  clearance).
- `completed` — Nimbus's DLF Phase III (closeout Q1 2026).
- `cancelled` — Modern-Alpha's Highway Maintenance (scope retracted).
- `active` **+ overdue endDate + promoted from awarded tender** —
  Nimbus's Andhra Solar Park Phase II EPC Consulting, `tenderId`
  populated against CW-2026-SOLAR-006, `endDate` 7 days past. One row
  covering both the tender-promotion path and the overdue affordance.

**Transactions (20).** 4 per `TransactionType` (3 project-level + 1
company-level per type). Cross-FK invariant strictly enforced — the
seeder re-asserts `transaction.companyId === project.companyId` on
every project-linked insert and throws loudly on mismatch.

`occurredOn` spread across May/Apr/Mar 2026 so both
`getTransactionsSummaryThisMonth` and `getTransactionsSummaryForPeriod`
(with arbitrary period windows) have non-trivial data. Total ledger
sum across all 20 rows ≈ ₹56 lakh inflow + ₹15 lakh outflow +
₹17 lakh refunds = mixed period totals.

**Token cleanup cron — new `lib/auth/tokens.ts::cleanupExpiredTokens`:**

- Sweeps `email_verification_tokens` + `password_reset_tokens` where
  `expires_at < now`.
- Returns `{ verificationDeleted, resetDeleted }` per-table counts.
- Uses the select-then-delete pattern (mirrors `pending-cleanup.ts`)
  because the better-sqlite3 + D1 drizzle surfaces don't expose
  `.changes` portably on `.delete()`.
- Used-but-still-pre-expiry rows are LEFT alone — they belong to the
  consume audit chain and only become eligible after both the consume
  AND the expiry window pass. Past expiry, both shapes are deleted.

**Token cleanup cron — new `scripts/cron-token-cleanup.ts`:**

Mirrors `cron-expiry-sweep.ts` / `cron-pending-cleanup.ts` line-for-
line — `dotenv/config` env load, db open, single-purpose sweep,
final result echo via `console.log`.

**Wrangler trigger.** Single new line in `triggers.crons`:
`"0 4 * * *"` (4 AM UTC daily, sequenced after the existing 02:00
expiry-sweep and 03:00 pending-cleanup). Rest of `wrangler.jsonc`
untouched.

**Package script.** `cron:token-cleanup` added to the scripts block.
Rest of `package.json` untouched.

**Tests in `lib/auth/__tests__/token-cleanup.test.ts` (+4):**

- Returns zero counts when both token tables are empty.
- Deletes only expired verification tokens, leaves live tokens intact.
- Same for password reset tokens.
- Sweeps both tables in one call with correct per-table counts.

Total at end of Chunk 2: **474 tests** (was 470; +4).

### Chunk 3 — Seed self-healing + dashboard verification (commit `369dec6`)

**The gap closed.** The seed's prior contract was "skip on exists":
lookup by natural key, insert if missing, skip otherwise. Bumping a
fixture's value (e.g. raising a company's `annualTurnover` from
₹50 cr to ₹100 cr) would silently NOT take effect on re-seed — the
lookup hit the existing row and skipped, so the in-DB value stayed
stuck at the old number.

**The new contract.** Compare-and-update on a per-entity documented
safe-to-update set. Three states now:

- `inserted` — natural-key lookup missed; full row inserted.
- `updated` — natural-key matched but at least one safe-to-update
  field differs from the spec; row UPDATEd in place, changed-fields
  list logged.
- `unchanged` — natural-key matched and every safe-to-update field
  equals the spec. Replaces the old `skipped`.

**Frozen vs updatable per entity, documented inline in each seeder:**

| Entity | Frozen on update | Updatable |
| --- | --- | --- |
| users (staff + company) | id, email, passwordHash, companyId, createdAt, updatedAt | role, name, isActive, emailVerifiedAt |
| companies (all variants) | id, name, isJv, createdAt, updatedAt | sector, geography, gst/pan, isMsme, complianceStatus, parentCompanyIds (JV only), annualTurnover, contact info, address, internalNotes |
| documents | id, companyId, fileKey, fileName, uploadedBy, uploadedAt, reviewedAt, createdAt, updatedAt | documentType, mimeType, sizeBytes, status, reviewNotes, reviewedBy, issuedOn, expiresAt |
| tenders | id, referenceNumber, publisherCompanyId, publishedAt, createdAt, updatedAt | title, description, status, sector, geography, eligibility filters, openingDate, closingDate, awardedCompanyId, internalNotes |
| tender applications | id, tenderId, companyId, submittedAt, createdAt, updatedAt | status, coverNote, internalNotes, decidedAt |
| projects | id, companyId, name, createdAt, updatedAt | description, tenderId, status, startDate, endDate, budgetInr, internalNotes |
| transactions | id, companyId, referenceNumber, createdAt, updatedAt | type, amountPaise, currency, projectId, occurredOn, notes, internalNotes |

**Companion fix — `SEED_VERIFIED_AT` constant.** The user fixtures
used `new Date().toISOString()` for `emailVerifiedAt`, which
recomputed on every seed run. With the new compare-and-update contract
that would have made every verified user look "updated" on every
re-run — non-idempotent. Replaced with a stable
`"2026-01-01T00:00:00.000Z"` constant; the exact value doesn't matter
semantically (only non-null vs null), the stability does. One-time
migration writes the constant into the existing DB rows on first
re-seed; subsequent runs are unchanged.

**Test plumbing.**

- `main()` exported + guarded with `!process.env.VITEST` so the test
  module can `import { seedStandaloneCompany, ... } from "../seed"`
  without firing the full pipeline at import time. Vitest sets
  `VITEST=true` itself; the env-var signal is cleaner than the
  ESM `import.meta.url` vs `process.argv[1]` URL equality dance
  (which is finicky on Windows path separators).
- `vitest.config.ts`: `scripts/**/__tests__/**/*.test.ts` added to
  the include list. Single-line addition, test-discovery only — no
  behavioural change to any test runtime.

**Tests in `scripts/__tests__/seed.test.ts` (+8):**

- Empty DB: first call inserts every row.
- Identical fixtures: second + third calls land every row as
  `unchanged`; row count doesn't grow.
- `seedStaffUser` is idempotent with `SEED_VERIFIED_AT` (the
  load-bearing fix for the user-update bug).
- Bumping `annualTurnover` from ₹5 cr to ₹50 cr triggers `updated`;
  the in-DB column carries the new value; no duplicate row.
- Bumping a user's `isActive` from true to false triggers `updated`.
- Tender status flip from `draft` to `published` takes effect on
  re-seed.
- Frozen-field guarantee: even when 3 updatable columns move,
  `id` and `createdAt` stay put.
- The Consultway publisher self-heals identically — frozen id, edits
  propagate.

Total at end of Chunk 3: **482 tests** (was 474; +8).

**Manual dashboard + reports verification — DEFERRED.**

Claude can't render the UI. The prompt's checkpoint browse-and-flag
step requires a human pointing a browser at the running dev server.
The data layer covering these flows is exercised by the existing
test suite (period helpers + visibility + RBAC). Flagged as a Day 22
opener: do a manual browser pass against the now-fully-seeded DB,
confirm KPIs render non-zero, reports cards show period data,
PDF download works against the fresh fixtures, company role sees
only own-scope data.

## Key decisions

**Two new companies, not five.** The original seed-plan listed
coverage targets the existing 5 standalones + 2 JVs mostly already
hit. Only two long-tail axes needed new rows: the `expired`
complianceStatus state (Vertex) and the stated-high/low
annualTurnover dimension (Vertex low + Nimbus high). Adding more
companies just to hit higher row counts would have made the dashboard
visually noisier without exercising any new code path.

**`SEED_VERIFIED_AT` as a stable timestamp constant.** With
compare-and-update in place, any field set via `new Date()` at
module-load time would flip every re-seed. The user fixtures were
the only place this pattern was used. Replacing it with a stable
constant kept the contract clean; the exact date is arbitrary, only
the non-null shape matters for "this account is verified" semantics.
The decided-at and submitted-at timestamps on tender applications
are similarly stable (computed from `Date.now() + N * 86_400_000`),
but those are inserted ONCE (`submittedAt` is frozen on update;
`decidedAt` is excluded from the diff so identical fixtures don't
look "updated"). Documents' `reviewedAt` follows the same pattern.

**Frozen vs updatable, picked per entity.** The seed-plan called for
a small documented set; I leaned broader — every column that's
fixture-driven and not naturally frozen (primary keys, natural keys,
FKs, audit timestamps, password hashes) is updatable. The risk of an
overly-broad update set is low because the seed runs only against
dev/UAT databases, never production. The benefit of broader updates
is that any fixture edit "just works" — you don't have to ask
yourself "is this field in the updatable list?".

**`reviewedAt` / `publishedAt` / `submittedAt` deliberately frozen.**
These are real-world event timestamps that the audit chain depends
on. Re-stamping them on every status-change re-seed would obscure
the actual moment-of-event. The first insert captures the seed-time
clock; subsequent updates leave the timestamp alone. If you really
need to bump one, delete the row manually and re-seed.

**Cross-FK invariant re-asserted at insert time.** The schema can't
express "transactions.companyId must equal projects.companyId when
projectId is set" — that's a runtime-app responsibility. The seed
re-asserts it on every project-linked transaction insert and throws
loudly on mismatch (with a message naming both sides). Catches typos
in the fixture file that would otherwise silently corrupt the ledger.

**Tender awarded company resolved by NAME at seed time.** Same
pattern as JV partners — the awarded tender's spec carries
`awardedCompanyName: "Nimbus Infraworks"`, and the seeder calls
`lookupCompanyId` to resolve. Keeps the fixture file readable
(human-meaningful names) and decoupled from `newId()`'s output.

**Token cleanup uses the select-then-delete pattern.** The existing
`pending-cleanup` cron uses it because the better-sqlite3 + D1
drizzle surfaces don't expose `.changes` on `.delete()` portably.
Mirroring that pattern keeps the codebase consistent and gives the
operator log line accurate per-table delete counts.

**Token cleanup runs at 4 AM UTC, sequenced after the other two
sweeps.** Expiry-sweep at 02:00, pending-cleanup at 03:00,
token-cleanup at 04:00. Each cron is short (single SELECT + DELETE
per table) so the gaps are generous — no risk of one delaying the
next.

**The seed's `main()` is exported + VITEST-guarded.** Tests need to
exercise the seeders without firing the full pipeline; the file
needed to support being both a CLI entry point AND an importable
module. The `process.env.VITEST` guard is the cleanest signal; the
alternative `import.meta.url === pathToFileURL(process.argv[1]).href`
pattern is finicky on Windows path separators.

## Gotchas surfaced

**`pnpm db:reset` is held by the dev server.** When `pnpm dev` is
running, better-sqlite3 holds the SQLite file handle open. The
reset-db script's unlink fails with EBUSY on Windows. Worked around
by running `pnpm db:seed` against the existing DB (the additive
path lands new rows + the self-healing UPDATEs hit the changed
fields). Full reset-migrate-seed pipeline runs against the in-memory
DB on every test worker — covered by the unit tests.

**`new Date().toISOString()` in seed fixtures is a footgun under
compare-and-update.** Any spec field computed at module-load time is
non-deterministic across runs, and the diff sees it as a change.
Caught on the first Chunk-3 verification run: 6 user rows showed as
`updated` on re-seed because `emailVerifiedAt: new Date()` produced
a new timestamp each invocation. Fixed by the `SEED_VERIFIED_AT`
constant. Any future fixture that wants a "seeded sometime in the
past" timestamp should use a stable string, not a runtime value.

**Drizzle's `.delete()` doesn't surface `.changes` portably.** D1's
drizzle wrapper and better-sqlite3's both have driver-specific shapes
for the delete return value, and the public Drizzle API doesn't
expose changes counts on the promise in a stable way. The
`pending-cleanup` cron already used a select-then-delete workaround;
the new `cleanupExpiredTokens` helper follows the same pattern.
Inefficient by one round-trip per table but operator-friendly (the
counts are load-bearing for the log line).

**The pre-confirm `pending` document is short-lived in production.**
The Chunk-1 Nimbus `pending` GST sits indefinitely in the seed-bound
DB but in production the pending-cleanup cron sweeps it after 60
minutes. So the seed creates the row fresh each `pnpm db:seed` run
(the cron + seed are decoupled), but if the cron has run between
seeds, the next seed re-inserts the swept row. Worth knowing during
demos: don't run pending-cleanup right before the demo if you want
the pending-status UI affordance to show.

**Tender applications' `decidedAt` excluded from the diff.** The
timestamp is derived from `decidedInDays` at insert time, but the
spec change that matters for the contract is the `status` field, not
the day-offset itself. Including `decidedAt` in the diff would have
made every fixture with a non-null `decidedInDays` look "updated"
every re-seed because `Date.now()` shifts. Excluded from the diff but
kept in the UPDATE set — if status flips, decidedAt flips too via the
fresh compute.

**The `vitest.config.ts` include pattern is path-rooted.** Tests in
`scripts/__tests__/` weren't being discovered until the include
pattern was extended. The pattern is a leading-prefix glob, not an
arbitrary search — `lib/**` excludes anything outside `lib/`. Single-
line addition kept the test-discovery change minimal.

**Vitest's per-worker in-memory DB lets seed tests run in isolation.**
The Day 11 setup file applies migrations to a fresh `:memory:` DB
per Vitest worker. The Chunk-3 seed tests use `beforeEach` to clear
every table (in FK-reverse order: `remindersSent` →
`passwordResetTokens` → `auditLog` → `transactions` → ... →
`companies`), then call the exported seeders directly. No cross-test
leak, no need for fixture mocking.

## Surfaces touched

```
# Chunk 1 — Phase-1 fixture extension (commit 823c73c)
scripts/seed.ts                                                      (modified — +180 lines)

# Chunk 2 — Phase-2 + Phase-3 fixtures + token-cleanup cron (commit 378f049)
lib/auth/__tests__/token-cleanup.test.ts                             (new — 4 tests)
lib/auth/tokens.ts                                                   (modified — +cleanupExpiredTokens)
package.json                                                         (modified — +cron:token-cleanup script)
scripts/cron-token-cleanup.ts                                        (new — local cron entry)
scripts/seed.ts                                                      (modified — +1019 lines of fixtures + seeders)
wrangler.jsonc                                                       (modified — +0 4 * * * cron trigger)

# Chunk 3 — Seed self-healing + dashboard verification (commit 369dec6)
scripts/__tests__/seed.test.ts                                       (new — 8 tests)
scripts/seed.ts                                                      (modified — compare-and-update refactor)
vitest.config.ts                                                     (modified — +scripts/**/__tests__ in include)

# Day 21 report (this commit)
docs/reports/day-21-report.md                                        (new)
```

## Test totals

Before this session: **470 tests across 26 files**, all green (Day 20
end state).

After this session: **482 tests across 28 files**, all green every
run. Net: **+12**.

Breakdown of the delta:

- +0: Chunk 1 (fixture data only — no test code).
- +4: `lib/auth/__tests__/token-cleanup.test.ts` (Chunk 2, new file).
- +8: `scripts/__tests__/seed.test.ts` (Chunk 3, new file).

The brief budgeted ~4-10 new tests; landed at +12 — slight overshoot
because the self-healing contract benefited from one extra test for
the Consultway publisher self-heal path on top of the planned core
four.

## Followups for Day 22+

**From this session:**

1. **`pnpm db:reset` smoke check, manual dashboard verification, and
   manual PDF download.** Deferred because the dev server was holding
   the SQLite file. First thing to do once `pnpm dev` is stopped: run
   `pnpm db:reset` to confirm the reset → migrate → seed pipeline
   lands cleanly from scratch, then browse `/dashboard` + `/dashboard/reports`
   as admin / staff / company-role users and flag any visual issues.
   Download the PDF report against the freshly-seeded data; eyeball
   the cover + three sections against the new transaction roster.
2. **Realistic Indian-flavoured fixture data.** Today's seed uses
   placeholder names ("Vertex Power Systems") and synthetic CIN/GST
   numbers. A polish pass with realistic-looking data — verifiable
   GST format, plausible company addresses, named contact persons —
   would land before any client UAT pass.
3. **Real R2 fixture files.** Per the seed plan, `fileKey` still
   points at non-existent R2 objects. Staging 2-3 real PDFs and
   wiring their keys into the seed (e.g. for Acme's verified docs +
   Vertex's expired trade license) would let the download path be
   exercised against real bytes during UAT.
4. **Token cleanup wired into the OpenNext scheduled handler.** Today
   `cleanupExpiredTokens` runs via local `pnpm cron:token-cleanup`.
   When the OpenNext + D1 deployment session lands (carry-forward
   #23-#25 below), it joins the scheduled-handler dispatch alongside
   the other two crons.
5. **Charts on the dashboard + report.** Still deferred — a separate
   UX pass adds per-status sparklines / trend bars. The fully-seeded
   dataset (20 transactions across 3 months) is now rich enough to
   show meaningful trend data, so this UX pass has a real-feeling
   substrate to design against.
6. **Period-over-period comparison on the reports.** Future session.
   Same shape — the period helpers take arbitrary `(start, end)`, so
   adding a second "previous period" panel is a layout change, not a
   data-layer change.
7. **`updateTransaction` audit `typeChange` only — `companyId` not
   patchable.** Carry-forward — Phase-3 hardening.

**Carried forward from Day 20+ (unchanged):**

8. **Real Consultway logo on the PDF cover.** Awaiting brand asset.
9. **Streaming exports beyond 1000 rows.** Phase-3 work.
10. **Searchable typeahead selects on the project / transaction /
    tender forms + the reports company picker.** Phase-1 scale doesn't
    need it.
11. **Per-document CSV export.**
12. **Bulk CSV import.**
13. **Saved-report-config persistence.**
14. **Dashboard widget loading skeletons** (cards behind `<Suspense>`).
15. **`deleteProject` action.** Day 16 carry-forward.
16. **Project-attached documents.** Schema doesn't link docs to
    projects today.
17. **Side-by-side detail view at desktop `xl:` widths.**
18. **`TransactionTypeBadge` / `ProjectStatusBadge` / `TenderStatusBadge`
    share a palette pattern.** Every day flags this; still premature.

**Carried forward from Day 16 / 15 (unchanged):**

19. **Session invalidation on password reset.** Phase-3 hardening.
20. **Multi-step registration UX.**
21. **CAPTCHA / rate limiting** on `/register`, `/forgot-password`,
    token-consume endpoints.
22. **Public tender browsing.**
23. **`@opennextjs/cloudflare` install + `open-next.config.ts`.**
24. **D1-backed Drizzle client factory.**
25. **Resend domain verification + production secret.**
26. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
27. **Hoist `escapeHtml` to a shared helper.**

**Already-resolved this session:**

- Day-20 followup #1 (UAT seed fixture buildout) — all three chunks
  delivered.
- Day-15 followup (Token cleanup cron) — landed in Chunk 2.
- Day-20 followup #27 (Seed self-healing on changed fixtures) — landed
  in Chunk 3.

## Carry-forward to Day 22

- **`dev` ended at 3 commits past Day-20's report commit (`e2c4118`)**
  before this report's own commit: `823c73c` / `378f049` / `369dec6`.
  Run `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing still requires explicit approval per `<permissions>`.
- **482 tests passing on every run.** Two new test files added
  (`lib/auth/__tests__/token-cleanup.test.ts`,
  `scripts/__tests__/seed.test.ts`); no existing test files modified.
- **Schema stays at migration 0012.** No new migration this session.
- **Zero new dependencies** this session. Day 20's
  `@react-pdf/renderer ^4.5.1` remains the only addition since Day 19.
- **`pnpm cron:expiry-sweep`** now reports `remindersAttempted=1`
  (Vertex GST T-7 from Chunk 1) + `remindersSkippedDeduped=1`
  (Acme trade_license T-30 dedup). Was 0/1 in Day 20.
- **`pnpm cron:pending-cleanup`** clean. The seed's `pending` Nimbus
  document is fresh-inserted per re-seed; the cron's 60-minute cutoff
  shouldn't sweep it during demo windows unless the demo opens with
  pending-cleanup.
- **`pnpm cron:token-cleanup`** clean on first + second run. Empty
  token tables on the dev DB.
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 21 didn't add
  new email surfaces.
- **`PASSWORD_PEPPER`** unchanged.
- **`lib/reports/pdf.tsx`** remains the single source for PDF
  rendering. Day 22's manual verification will download a PDF against
  the freshly-seeded data.
- **`list*ForExport` (transactions / projects / tenders)** still the
  export-only path with the 1000-row cap. Day 21 didn't touch the
  exporters, but the new 20-transaction + 6-project + 6-tender
  fixtures give the CSV export real volume to exercise on Day 22's
  verification.
- **`<EmptyState>`** wired across every list page + audit feed +
  reports cards (Day 19). With the Chunk-2 fixtures in place, very
  few empty states should render on a freshly-seeded DB — flag any
  that DO render as a regression hint on Day 22's manual pass.
- **`scripts/seed.ts` now exports its seeders + `main()`** behind a
  `!process.env.VITEST` guard. Future seed-related tests can import
  any seeder directly.
- **`docs/seed-plan.md`** is now fully executed. The doc stays as the
  authoritative description of the UAT fixture coverage target;
  future seed extensions reference it for the natural-key contract
  + safe-to-update field set.
- **`pnpm db:reset` deferred** — the dev server held the SQLite file.
  Day 22 opener: stop `pnpm dev`, run `pnpm db:reset`, browse the
  dashboard + reports as each of admin / staff / company-role users,
  flag any visual issues.

That's Day 21.
