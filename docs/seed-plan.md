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
