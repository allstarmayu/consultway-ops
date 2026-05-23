# Seed plan — Day 21 UAT fixture buildout

_Created Day 20, executed Day 21._

The current `scripts/seed.ts` covers the auth + companies skeleton (admin /
staff / one company-role user, the Consultway sentinel publisher, five
client companies + two JVs, one verified document). That's enough for
ad-hoc walkthrough but not enough for a client UAT pass on the full ops
suite — tenders, applications, projects, transactions, documents, audit
trail, and reports all need representative data.

Day 21 lifts the seed into a complete fixture set covering every persona,
every state, and the long-tail edge cases the UI has to handle.

## What the seed needs to cover (Day 21)

**Companies** (extend the existing 5 + 2 JV):

- One MSME-flagged company, one non-MSME.
- One company across each `complianceStatus` (`pending`, `under_review`,
  `verified`, `rejected`, `suspended`).
- One company with `annualTurnover` set high enough to clear every
  seeded tender's `minAnnualTurnoverInr`; one set low enough to be gated
  out.
- One company with zero documents, one with mixed-status documents.

**Users** (extend the existing admin + staff + Acme):

- Second staff user so role-collision tests have a peer.
- Second + third company-role users on different companies — at least
  one with `emailVerifiedAt = null` to exercise the un-verified state.
- One user with `isActive = false` so the disabled-account path renders.

**Documents** (extend the single existing verified row):

- Every `DocumentStatus` (`pending`, `under_review`, `verified`,
  `rejected`) represented at least once.
- A document with `expiresAt` in `< 7 days` so the expiry-sweep cron has
  something to surface.
- A document with `expiresAt` already passed (expired-but-not-deleted).
- A `rejected` document with `reviewNotes` populated.

**Tenders** (none seeded today):

- One in each `TenderStatus`: `draft`, `published`, `closed`, `awarded`.
- Published tenders cover both `msmeOnly: true` and `false`.
- One published tender with `closingDate` already past (over-the-line
  state — UI shows it as closed-via-deadline rather than via the explicit
  status flip).
- One tender with `eligibleSector` / `eligibleGeography` set, one without.
- One tender with `minAnnualTurnoverInr` set high enough to gate out
  most companies, one with the threshold unset.
- The awarded tender's `awardedCompanyId` populated.

**Tender applications** (none seeded today):

- One application in each `TenderApplicationStatus`: `submitted`,
  `shortlisted`, `rejected`, `withdrawn`.
- The awarded tender has its winning company's application marked
  shortlisted (precondition to the award per the state machine).
- One company with multiple applications across tenders so the
  per-company application list has more than one row.

**Projects** (none seeded today):

- One project per `ProjectStatus`: `planning`, `active`, `on_hold`,
  `completed`, `cancelled`.
- One project promoted from the awarded tender (`tenderId` set);
  others direct-created.
- Each project has a non-null `budgetInr`, `startDate`, `endDate`.
- One project with `endDate` in the past + status `active` so the
  "overdue" UI affordance has a row to render.

**Transactions** (none seeded today):

- At least 3 rows per `TransactionType` (`invoice`, `payment`, `expense`,
  `advance`, `refund`).
- Cover the cross-FK invariant: every transaction with a non-null
  `projectId` matches the project's `companyId`.
- Spread `occurredOn` across the last three months so the period
  helpers (`getTransactionsSummaryThisMonth`,
  `getTransactionsSummaryForPeriod`) all have non-trivial data.
- One company-level (no project) transaction per type to exercise the
  NULL-project branch on the list page.

**Audit log** — populated naturally by the seed mutations once everything
above is in place. No explicit seed rows; the script just calls the
actions, and `recordAuditEvent` does the right thing.

## Idempotency

Per the existing seed's contract, every insert is idempotent — skip when
the natural key already exists. The Day-21 additions extend this pattern:

- Companies: lookup by `name`.
- Users: lookup by `email`.
- Documents: lookup by `(companyId, type, fileName)`.
- Tenders: lookup by `referenceNumber` (when set) or by `title`.
- Projects: lookup by `(companyId, name)`.
- Transactions: lookup by `(companyId, referenceNumber)` when reference
  is set; otherwise insert without dedup (transactions are write-once
  ledger rows).

Re-running `pnpm db:seed` against an already-seeded DB lands a clean
no-op log line. `pnpm db:reset` wipes and re-seeds from scratch.

## What this doc is NOT

- A migration. No schema changes are implied — Day 21 works on the
  Day-19 migration 0012 baseline.
- A test fixture. Vitest fixtures live in each module's `__tests__/`
  folder and seed their own rows.
- A production seed. The local SQLite driver is the only target.
  Production data lands through the registration flow, not the seed.

## Out of scope (carry to later sessions)

- Real fixture documents in R2. The seed creates D1 rows; the R2 objects
  for them are still placeholders. Day 21 may stage one or two real
  PDFs to verify the download path, but the bulk of the seed leaves
  `fileKey` pointing at non-existent objects.
- Realistic Indian company names + addresses + CINs. The seed uses
  short placeholder values today; a polish pass with realistic-looking
  data is a separate UX task.
- Dependent counts ("seed 100 companies"). Phase-1 scale is small; the
  seed targets coverage, not volume.

---

# Seed plan v2 — Day 22 volume lift

_Day-22 extension. Day 21 covered the long-tail STATE axis (every
status, every type); Day 22 covers the VOLUME axis on top so the
dashboard and reports surfaces have enough rows to feel like a real
post-launch dataset._

The plan stacks on Day-21's natural-key idempotency contract +
compare-and-update self-healing. Same per-entity frozen vs updatable
field set. The new `rejectionReason` column on `companies` is
classified as updatable so a fixture edit propagates on re-seed.

## SEED_SCALE knob

`process.env.SEED_SCALE` selects the row count target. Three profiles:

- `small`  (~1/5 scale, CI): ~6 companies, ~24 docs, ~5 tenders,
  ~12 apps, ~5 projects, ~50 transactions.
- `medium` (~1/2 scale): ~15 / ~60 / ~12 / ~30 / ~12 / ~125.
- `large`  (default, full demo): ~30 / ~120 / ~25 / ~60 / ~25 / ~250.

`pnpm db:seed` = large. `pnpm db:seed:small|medium|large` pick a
non-default profile inline via `cross-env`.

## What gets seeded (large profile)

### Companies (~30 rows)

- 4 pending, 20 compliant, 3 suspended, 3 rejected (with reason)
- ~5 JVs (drawn from compliant set) + ~8 MSMEs (compliant + JVs)
- Sectors: Infrastructure / Solar EPC / Civil Works / Renewable /
  Real Estate / Manufacturing
- Geographies: Maharashtra / Karnataka / Tamil Nadu / Delhi NCR /
  Gujarat / Pan India
- ~12 with `annualTurnover` populated (₹2 cr → ₹500 cr spread)

### Users (~30 rows)

- 3 admins + 6 staff (all `@consultway.info`)
- 1 company-user per active company (~25 rows)
- All `emailVerifiedAt = SEED_VERIFIED_AT`
- 1 in 5 marked `isActive = false`

### Documents (~120 rows)

- 4–6 per active company
- Status mix: 60% verified / 20% pending_review / 10% rejected /
  10% expired
- ~10 with `expiresInDays` in (0, 30] for cron coverage
- ~3 with `expiresInDays < 0` for expired-flip coverage
- All 7 `DocumentType` values represented

### reminders_sent (~5 rows)

- Pre-populated across (T-30 / T-14 / T-7 / T-1) slots so the audit
  trail isn't pristine on a fresh seed.

### Tenders (~25 rows)

- 5 draft + 12 published + 5 closed + 3 awarded
- ~22 published by Consultway sentinel, ~3 sub-contracted
- ~8 with `minAnnualTurnoverInr`, ~5 with `eligibleSector`,
  ~3 with `msmeOnly`
- Awarded rows have `awardedCompanyId` populated against a
  shortlisted application's company

### Tender applications (~60 rows)

- 3–8 per published tender; every compliant company has 1–3 apps
- Status mix: 40% submitted / 20% shortlisted / 20% rejected /
  15% withdrawn / 5% awarded (reflected on the tender row)

### Projects (~25 rows)

- 5 planning + 10 active + 3 on_hold + 5 completed + 2 cancelled
- ~10 with `tenderId` populated (promoted), ~15 standalone
- Budgets on ~20 (mix of lakh + crore range)

### Transactions (~250 rows)

- ~20/month spread across the last 12 months
- Type mix: 30% invoice / 30% payment / 20% expense / 10% advance /
  10% refund
- ~60% project-tagged (cross-FK invariant enforced), ~40%
  company-level
- All carry a unique `referenceNumber` for idempotency
- Deterministic PRNG seeded from a fixed value so amounts/dates are
  stable across runs

### Audit log

Each insert path calls `recordAuditEvent` directly so the activity
feed widget has natural history on a fresh seed. Skipped on updates
to keep re-seeds from doubling audit rows.

## Invariant verifier

`pnpm seed:verify` → `tsx scripts/seed-invariants.ts`. Re-asserts:

1. Project-linked transactions: `txn.companyId == project.companyId`
2. Rejected companies have a populated `rejectionReason`
3. Awarded tenders have a populated `awardedCompanyId`
4. Tender applications: `(tenderId, companyId)` unique
5. `reminders_sent`: `(documentId, reminderKind)` unique
6. No orphan FKs anywhere
7. Every enum-typed value is in its known union

Exits 0 on clean, 1 on any failure with sample row ids.

## Acceptance

- `pnpm db:reset` → full from-scratch reset + migrate + seed (large)
  under 30s
- `pnpm db:seed` re-run → every row `unchanged` (self-healing holds
  at volume)
- `pnpm db:seed:small` against a wiped DB → small profile lands cleanly
- `pnpm seed:verify` → clean against every freshly-seeded scale
- `pnpm cron:expiry-sweep` → `remindersAttempted >= 10`
- Dashboard + reports show non-trivial multi-month data across roles
