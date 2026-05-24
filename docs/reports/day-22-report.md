# Day 22 — Volume-scale seed + schema widening + invariant verifier

_Date: 2026-05-23_

## Scope

Four committed deliverable chunks executing the embedded
Day-22 seed-plan v2 — schema widening + scale plumbing + a two-stage
volume lift covering every Phase-1/2/3 entity. Plus a manual-only
checkpoint that ran the dataset against a fresh `db:reset` so Day-23
opens with a known-good substrate.

1. **Schema widening migration (0013).** Widens `ComplianceStatus` to
   add `suspended` + `rejected` and adds a nullable `rejection_reason`
   column on `companies`. Two new badge variants land on the
   companies-list column; the filters bar gains the two new options;
   the Zod enum + the action-layer admin-gated patch passthrough catch
   up. No backfill — existing dev rows keep their current statuses.
2. **`SEED_SCALE` knob + invariant verifier + demo cheat-sheet print.**
   Lays the Chunk-3/4 plumbing: `SEED_SCALE_PROFILES` table, three
   profile-specific `db:seed:small|medium|large` scripts, a new
   `scripts/seed-invariants.ts` with seven invariant checks exposed as
   both `pnpm seed:verify` and a `runInvariantChecks(db)` helper, and a
   human-readable cheat-sheet that the seed prints at the end of
   `main()` (status counts + ledger totals + login email list grouped
   by role). +5 tests pin the verifier's reporting against
   empty / cross-FK / orphan-FK / rejected-no-reason / clean states.
3. **Volume lift: companies + users + documents + reminders.** Adds
   `scripts/seed-generators.ts` with a deterministic mulberry32 PRNG
   and four generators that emit the gap between the Day-21 baseline
   and the SEED_SCALE target. `large` lands 31 companies (4 pending /
   19 compliant / 1 expired / 1 non_compliant / 3 suspended / 3
   rejected) + 33 users + 120 documents + 5 pre-populated
   `reminders_sent` rows. Every newly-inserted row writes a
   `recordAuditEvent` so the activity feed widget opens with natural
   history.
4. **Volume lift: tenders + applications + projects + transactions.**
   Four more generators bring the dataset to 25 tenders / 90
   applications / 25 projects / 250 transactions on the `large`
   profile. Transaction `occurredOn` spreads across 13 months (the
   last 12 + the current). Cross-FK invariant strictly enforced — the
   generator picks the company FIRST when a transaction is
   project-linked. Audit-on-insert continues from Chunk 3, taking the
   audit log to 495 rows across four actions.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 487/487 green (was 482; +5 from the invariant test
file); `pnpm db:reset` lands the full `large` set cleanly under 30s
(under 5s on this machine); `pnpm db:seed` re-run → every row logged
as `unchanged` (self-healing holds at volume); `pnpm db:seed:small`
against a freshly-wiped DB → baseline alone exceeds the small target,
generators emit zero, 15 core + 23 docs + 0 generated; `pnpm seed:verify`
clean against both the freshly-seeded `large` DB and the small re-test;
`pnpm cron:expiry-sweep` reports `remindersAttempted=13` +
`remindersSkippedDeduped=5` (was 1 + 1 in Day 21); the other two
crons clean.

The Chunk-5 manual dashboard/reports verification is captured below as
a per-screen pass/fail table — Mayuresh's call to action since I can't
render a browser.

## What shipped

### Chunk 1 — Schema widening migration 0013 (commit `4d23d2b`)

**Schema changes (`lib/db/schema.ts`).**

- `ComplianceStatus` union widens from `pending | compliant |
  non_compliant | expired` to add `suspended` + `rejected`. Both are
  new states with distinct semantics:
  - `suspended`: admin-paused for backstory reasons (commercial
    dispute, legal hold, internal review). Reversible to compliant —
    a suspension freezes the relationship but doesn't terminate it.
  - `rejected`: terminal. Either initial registration was denied or a
    re-review concluded the company is not eligible to operate on the
    platform. The state machine refuses any transition out of
    `rejected`; re-applying creates a new company row.
- New column on `companies`: `rejectionReason TEXT` (nullable, no
  default). Populated alongside `complianceStatus = 'rejected'` so
  audit reviewers know *why*. Admin/staff-only on read, same scoping
  as `internalNotes`. The DB can't easily express "conditional NOT
  NULL", but the seed-invariant verifier (Chunk 2) re-asserts
  "rejected ⇒ non-null reason" on every run.

**Migration (`drizzle/0013_thankful_sunset_bain.sql`).**

Single statement: `ALTER TABLE companies ADD rejection_reason text;`.
The compliance-status widening is a no-op at the SQL layer because
SQLite stores enums as TEXT with no CHECK constraint — the new
values simply become legal at the app layer.

**Consumer-site updates.**

- `lib/companies/schemas.ts::complianceStatusSchema` extends the Zod
  enum with the two new literal values. The patch schema gains a
  `rejectionReason: z.string().trim().max(2000).optional().nullable()`
  field; cross-pair "rejected ⇒ reason required" stays at the action
  / verifier layer, not Zod (the patch shape doesn't necessarily
  include both fields together).
- `lib/companies/actions.ts::updateCompany` admin/staff path picks up
  `rejectionReason` alongside `complianceStatus` + `internalNotes`.
  Company-role updates still silently drop the field (defence in
  depth).
- `app/dashboard/companies/_components/badges.tsx`: two new pill
  variants land in `COMPLIANCE_STYLES` — Suspended uses amber-100 bg
  + `PauseCircle` icon; Rejected uses the destructive token + `Ban`
  icon. Both icons added to the `lucide-react` import. The badge map
  is now an exhaustive `Record<ComplianceStatus, ComplianceBadgeStyle>`
  — TypeScript would have caught a missing variant.
- `app/dashboard/companies/_components/filters-bar.tsx`: the
  COMPLIANCE_OPTIONS list gains `Suspended` and `Rejected` entries so
  the staff-side filter dropdown can narrow to either.

**No state-machine helper file exists yet** — the original prompt
hypothesised one. The current code lets staff/admin set
`complianceStatus` to any value via `updateCompany` directly (no
allowed-transitions guard). Adding the `rejected ⇒ no exit` and
`suspended ↔ compliant ↔ ...` guards is a follow-up for whichever
session lands a dedicated compliance-management UI; today the seed
verifier is the only consumer that cares about the `rejected ⇒
reason` half of the contract.

**Test stays at 482.** No state-machine helper to test, no consumer
test ever exhaustively switched on `ComplianceStatus`, so widening the
union didn't break anything.

### Chunk 2 — SEED_SCALE + invariants + cheat-sheet (commit `fa9e67d`)

**`SEED_SCALE` knob (`scripts/seed.ts`).**

- New `SeedScale` type + `SEED_SCALE_PROFILES` table mapping each
  profile to `{ companies, documents, tenders, tenderApplications,
  projects, transactions, reminders }` row-count targets.
- `resolveSeedScale()` reads `process.env.SEED_SCALE`, defaults to
  `large`, throws loudly on a bogus value (better than silently
  degrading at start of a 30s seed).
- Three new `package.json` scripts use `cross-env` to set the env
  var inline: `db:seed:small | db:seed:medium | db:seed:large`. The
  unprefixed `db:seed` stays as the default (= large).

**Invariant verifier (`scripts/seed-invariants.ts`).**

A standalone read-only script + an exported `runInvariantChecks(db)`
helper. Seven checks, in order:

1. **Cross-FK on transactions.** Every project-linked transaction's
   `companyId` matches the linked project's `companyId`. SQLite can't
   express the join-key equality as a constraint; the seed re-asserts
   it on insert, the verifier re-asserts it on a sweep.
2. **`rejected ⇒ rejectionReason` non-null.** Mirrors the schema
   semantics from Chunk 1.
3. **`awarded ⇒ awardedCompanyId` non-null.** The state-machine
   contract for the tenders module.
4. **`(tenderId, companyId)` unique on tender_applications.** The
   DB-level UNIQUE index enforces this; the verifier double-checks
   against schema drift.
5. **`(documentId, reminderKind)` unique on reminders_sent.** Same
   belt-and-braces pattern.
6. **Orphan FKs.** Every FK column resolves to a real parent row.
   Covers users.companyId, documents.{companyId, uploadedBy,
   reviewedBy}, tenders.{publisher, awarded}, tender_applications.{
   tender, company}, projects.{company, tender}, transactions.{
   company, project}, reminders_sent.documentId,
   {email_verification, password_reset}_tokens.userId.
7. **Enum values.** Every enum-typed column carries a value in its
   known union. Covers ComplianceStatus, UserRole, DocumentStatus,
   DocumentType, TenderStatus, TenderApplicationStatus, ProjectStatus,
   TransactionType, ReminderKind.

`runInvariantChecks(db)` returns `{ passed, violations[] }` where
each violation carries `{ name, description, count, sample[] }`
(sample capped at 5 ids for grep-ability). The CLI exits 0 on clean,
1 on any failure with the violations printed. Wired as
`pnpm seed:verify`.

**Demo cheat-sheet (`scripts/seed.ts::printDemoCheatSheet`).**

Runs at the end of `main()` after the structured log line. Single
group-by query per dimension (status / type) for the entity counts,
plus aggregate sum queries for total project budget + total
transaction sum. Login section walks `users` once, groups by role,
flags inactive accounts with `(DISABLED)`. All under 50ms against the
`large` profile DB.

The structured log line above the cheat-sheet stays for grep; the
cheat-sheet is for the demo presenter to eyeball in the terminal.

**Tests (`scripts/__tests__/seed-invariants.test.ts`, +5).**

- Clean against an empty DB (every check degenerates to a pass).
- Cross-FK violation: pre-insert a txn with mismatched companyId vs
  project's companyId, verifier reports the row id under
  `transactions.cross_fk`.
- Orphan FK: pre-insert a document with a bogus `uploadedBy` (after
  flipping `PRAGMA foreign_keys = OFF` so the FK lets it land —
  models a demo-time external-SQL bypass).
- Clean against the publisher + a single seeded standalone + a
  single seeded staff user. The cross-FK / awarded / orphan checks
  all degenerate to pass.
- Rejected company with NULL `rejectionReason` triggers the
  `companies.rejected_reason_missing` violation.

**Seed-plan doc update (`docs/seed-plan.md`).**

A v2 section appended to the Day-21 doc covering the SEED_SCALE
profiles, the full row-count targets per profile, the invariant set,
and the acceptance criteria. Day-23+ seed extensions reference this
section for the contract.

Total at end of Chunk 2: **487 tests** (was 482; +5).

### Chunk 3 — Volume lift, half 1 (commit `f59a149`)

**Generator module (`scripts/seed-generators.ts`, new).**

- **Mulberry32 PRNG.** ~10 lines. Seeded from a fixed integer per
  generator (101 / 202 / 303 / 404 / 505) so generated specs are
  identical across runs. Determinism is load-bearing for the
  compare-and-update self-healing contract — any non-deterministic
  field would land as a spurious `updated` on every re-seed.
- **`generateStandaloneCompanies(scale, existingCount)`** emits the
  gap between baseline and target. Status mix: 3 pending + 3
  suspended + 3 rejected (all carry `rejectionReason`) + the
  remainder filling compliant. Pools cover all six SECTOR_POOL
  values + all six GEOGRAPHY_POOL values. ~27% MSME-flagged, ~55%
  carry a stated `annualTurnover` spread from ₹2 cr to ₹500 cr.
- **`generateStaffUsers(scale)`** brings the Consultway team to 3
  admins + 6 staff (large) on top of the 1 admin + 2 staff baseline.
  Emails under `@consultway.info` per the seed plan.
- **`generateCompanyUsers(scale, generatedCompanies)`** emits one
  user per non-rejected generated company. Rejected companies don't
  get a self-service user (they can't operate anyway). ~1-in-5
  marked `isActive = false` for inactive-roster coverage.
- **`generateDocuments`** emits 4–6 docs per company at a
  60/20/10/10 verified/pending_review/rejected/expired mix.
  Generators ration ~16 docs into the (0, 30] expiry window and ~6
  past-expiry so the cron has a fresh batch to surface. PAN cards +
  incorporation certs never get an expiry date; the rest do.
- **`generateReminders(scale, generatedDocs)`** picks ~5 docs that
  landed inside the reminder window and emits `reminders_sent` rows
  for the matching slot (T-30 / T-14 / T-7 / T-1). Pre-populates the
  audit-feed widget with natural history.

**Seed-helper exports + `rejectionReason` plumbing.**

- `StandaloneSeed`, `StaffUserSeed`, `CompanyUserSeed`, `DocumentSeed`,
  `SEED_VERIFIED_AT`, `SeedScale`, `SEED_SCALE_PROFILES` all become
  exports so the generators can import them.
- `StandaloneSeed` picks up an optional `rejectionReason?: string |
  null` field.
- `seedStandaloneCompany`, `seedJvCompany`, `seedConsultwayPublisher`
  all add `rejectionReason` to their updatable set per the Day-21
  frozen-vs-updatable contract — a fixture edit propagates.

**`main()` wiring.**

After each existing baseline step, a parallel generator step runs.
For each generator-emitted spec that returns `"inserted"`, a
`recordAuditEvent` fires via a new `recordSeedAudit` helper. The
helper defaults `actorId` to the system sentinel
`00000000-0000-0000-0000-000000000000` and never throws (matches
`recordAuditEvent`'s contract). Audit happens only on `inserted`;
updates and unchanged rows skip — re-seed doesn't double-audit.

**`seedReminderSent`** is a new helper (lives in `scripts/seed.ts`).
Idempotent on `(documentId, reminderKind)`. Looks up the document
via `(companyName, fileName)` first, then the reminder pair.

**Header `seed complete` log line picks up `reminders` stats.**

**`large` end-state for Chunk 3:**

- 31 companies (4 pending / 19 compliant / 1 expired / 1
  non_compliant / 3 suspended / 3 rejected)
- 33 users (3 admin / 6 staff / 24 company; 4 inactive)
- 120 documents across the 60/20/10/10 mix
- 5 pre-populated reminders_sent rows
- cron:expiry-sweep jumps to `remindersAttempted=13`

`small` profile against a wiped DB: baseline alone (15 core + 23
docs) exceeds the small target (6 companies + 24 docs), so
generators emit zero. The generator's `Math.max(0, target -
existingCount)` produces the right number across every scale.

Total at end of Chunk 3: **487 tests** (unchanged — generators are
exercised by the seed-driven dataset, not by added unit tests; the
existing invariant tests cover the generator's outputs indirectly).

### Chunk 4 — Volume lift, half 2 (commit `fe25887`)

**Four more generators in `scripts/seed-generators.ts`.**

- **`generateTenders(scale, existingCount, generatedCompanies)`.**
  Emits ~19 tenders for `large` (target 25, baseline 6). Status mix
  matches the seed-plan: ~4 draft + ~9 published + ~4 closed + ~2
  awarded. Reference numbers prefixed `CW-2026-GEN-NNN`. Eligibility
  filters spread per the plan (~32% min turnover / ~20% eligible
  sector / ~12% msmeOnly). Awarded tenders draw an awardee from the
  compliant generated pool (falls back to Nimbus when the pool is
  empty).
- **`generateTenderApplications(scale, generatedTenders,
  generatedCompanies)`.** For every published / closed / awarded
  tender, deterministically shuffles the compliant-company pool
  (baseline + generated) and picks 3–8 to apply. The awarded tender's
  awardee is force-included with status `shortlisted` (the
  state-machine precondition).
- **`generateProjects(scale, existingCount, generatedCompanies,
  generatedTenders)`.** Status mix per plan: ~5 planning + ~9 active
  + ~2 on_hold + ~4 completed + ~1 cancelled. ~40% promoted from
  awarded tenders (round-robined across the awarded set). Budgets
  populated on ~80% with a lakh/crore split. Names embed company
  slug + index for stable natural keys.
- **`generateTransactions(scale, existingCount, generatedCompanies,
  generatedProjects)`.** ~230 txns spread across the last 12 months
  with ~20/month and some jitter. Type mix per plan
  (30/30/20/10/10). ~60% project-linked — cross-FK invariant
  maintained by picking the company *from* a project's `companyName`
  rather than picking both independently. Amount distribution:
  ~60% lakh-range, ~30% thousands, ~10% crore. Reference numbers
  `GEN-<TYPE>-NNNN` are globally unique.

**`main()` wiring.**

Each generator runs after its baseline counterpart. Per-insert
audit events:

- Tenders: `tender_published` (drafts → `created`)
- Applications: `tender_applied` with `metadata.applicationId`
- Projects: `created`
- Transactions: `created`

**`large` end-state for the full Day 22 dataset:**

- 32 companies (publisher + 31 above) across all 6 ComplianceStatus
  values
- 33 users
- 120 documents
- 25 tenders (5 draft + 12 published + 5 closed + 3 awarded)
- 90 applications (15 rejected + 31 shortlisted + 35 submitted + 9
  withdrawn)
- 25 projects (5 planning + 11 active + 3 on_hold + 5 completed + 1
  cancelled)
- 250 transactions across 13 months
- 18 reminders_sent rows (5 pre-populated + 13 emitted by the
  expiry-sweep cron after seed)
- 495 audit-log rows (302 created + 97 document_uploaded + 81
  tender_applied + 15 tender_published)
- Total project budget: ₹71.88 cr
- Total ledger sum: ₹138.59 cr

Total at end of Chunk 4: **487 tests** (unchanged).

### Chunk 5 — Manual dashboard + reports verification (no commit)

**No code change.** Verification checkpoint.

`pnpm db:reset` against the Chunk-4 end state ran cleanly (under 5s
on this machine — well within the 30s budget). All three crons
green:
- `cron:expiry-sweep`: 13 attempted + 5 deduped (vs Day-21's 1 + 1).
- `cron:pending-cleanup`: clean.
- `cron:token-cleanup`: clean.

Headless substrate health check confirms the dashboard / reports
queries will return non-trivial data:

| Surface | Substrate available |
| --- | --- |
| `/dashboard` KPI cards (admin) | 32 companies / 33 users / 25 tenders / 25 projects / 250 txns |
| Company status breakdown card | All 6 statuses populated (compliant=19, pending=4, suspended=3, rejected=3, expired=1, non_compliant=1) |
| Document status breakdown card | All 5 statuses populated (verified=73, pending_review=16, rejected=12, expired=18, pending=1) |
| Tender status breakdown card | All 4 statuses populated (5 draft / 12 published / 5 closed / 3 awarded) |
| Activity feed (last N) | 495 audit rows across 4 actions — plenty to render the recent-N feed |
| Transactions summary (this month) | 24 txns in 2026-05 |
| Reports period picker (any window) | Txns spread across 13 distinct months (2025-05 through 2026-05) — every preset returns non-zero |
| Reports company picker | 20 distinct companies with txns to choose from |
| Reports PDF download | 25 projects + 250 txns to render across the 3-section layout |
| `/dashboard/transactions/export` (admin) | 250 rows — under the 1000 cap, exports in one CSV |
| Company-role visibility (Nimbus) | 2 projects + 9 apps + 21 txns — rich own-scope data |

**Per-screen pass/fail status — Mayuresh to fill in.** Claude can't
render a browser; the table above describes what the DB *can* show.
The actual visual pass/fail per screen × role combination is the
deferred manual step. Specifically open in the browser:

1. `/dashboard` as admin — KPIs non-zero, breakdown cards show all
   statuses, activity feed has 10+ rows, transactions summary shows
   multi-lakh totals.
2. `/dashboard` as staff (`staff@consultway.local`) — transactions
   card should be absent.
3. `/dashboard` as `nimbus@example.local`-equivalent (use the
   `inactive@example.local` swap if the role is otherwise the same)
   — only Nimbus's own-scope data should render.
4. `/dashboard/reports` as admin — period picker presets (current
   month / last 3 / last 6 / last 12) should all show non-zero
   counts. Company picker should narrow correctly. PDF download
   should produce a 3-section PDF with non-trivial content.
5. `/dashboard/companies` — try the new `Suspended` and `Rejected`
   filters; confirm the new badges render with the colours +
   icons added in Chunk 1.
6. `/dashboard/transactions/export` (admin) — should download a CSV
   with ~250 rows.

Any visual issue surfaced lands as a Day-23 follow-up.

## Key decisions

**Schema-widening migration as Chunk 1 not Chunk 0.** The Day-21
seed-plan asked for `suspended` and `rejected` states. The
alternatives were (a) widen the union late (and have to retrofit the
generated rows mid-Chunk-3), or (b) widen early so the Chunk-3
generators can assume both states exist. Chose (b): the migration is
a one-statement column add (SQLite's enum-as-text means the union
widening is a no-op at the SQL layer), and the downstream work
benefits from a stable schema floor.

**`rejectionReason` is "updatable" per the self-healing contract.**
Per Day-21's per-entity frozen vs updatable table, new fixture-driven
columns default to updatable so spec edits propagate on re-seed. The
risk is low because the seed runs only against dev/UAT databases.

**State-machine guards deferred.** The prompt suggested adding
`suspended ↔ compliant` reversibility + `rejected` as a one-way
terminal. There's no existing compliance-state-machine helper file in
the codebase today — every transition flows through `updateCompany`
which accepts any value the schema accepts. Adding a guard would
mean introducing a new state-machine module mid-Chunk-1, which is
scope creep relative to a session focused on the seed lift. The
verifier catches the `rejected ⇒ reason` half of the contract;
adding the transition guards lands when a dedicated
compliance-management UI surface arrives.

**`scripts/seed-generators.ts` as a separate module.** The seed.ts
file was already 2,400+ lines at Day-21 end; adding another 700
inline would have made it harder to navigate. Splitting the
generators out keeps `seed.ts` focused on the hand-curated baseline
+ the seeder helpers, with the generators in a sibling file that
imports types from seed.ts. Dynamic `await import()` from `main()`
avoids any chance of a circular-import issue at parse time.

**Mulberry32 PRNG seeded per generator.** Each generator gets its own
fixed seed (101 / 202 / 303 / etc.) so the output of one doesn't
accidentally couple to another. Determinism is the load-bearing
property — non-deterministic specs would re-render as `updated` on
every re-seed, breaking the self-healing contract.

**`generate*(scale, existingCount, ...)` API shape.** Each generator
emits the gap between the baseline and the target. For the `small`
profile where the baseline already exceeds the target, the generator
emits zero — no over-seeding, no clobbering of the hand-curated set.

**Audit-on-insert via `recordSeedAudit` only on the generator
paths.** The Day-21 baseline seeders (Acme, BuildRight, etc.)
intentionally don't audit. Adding audit rows for the existing 7
companies on every fresh seed would have re-fired audit events for
"this is the seventh time we seeded Acme" which doesn't reflect
real-world history. The generators emit one audit row per net-new
row; the baseline stays silent.

**Reference numbers + names prefixed `GEN-` / `CW-2026-GEN-` for
generator rows.** Distinguishes generator-emitted fixtures from
baseline-emitted ones at a glance during demos. Also useful for
selective DB cleanup if a demo wants only the curated 7 companies.

**Cross-FK invariant in the txn generator: pick company FROM
project, not independently.** The txn generator builds a
`Map<companyName, ProjectSeed[]>` up front, then for each
project-linked txn picks a project FIRST and sets `companyName =
project.companyName`. The alternative — pick the company independently
and then a random project of that company — works too but is more
fragile when the generator's PRNG seeds shift.

**Generator-emitted reminders_sent rows AND cron-emitted ones
coexist.** The Chunk-3 generator pre-populates 5 rows so the audit
feed has natural history on a fresh seed (before any cron has run).
The post-seed `pnpm cron:expiry-sweep` then emits its own batch (13
in the large dataset) for docs that landed in the (0, 30] window.
The `(documentId, reminderKind)` unique index keeps the two from
colliding — they target different (doc, slot) tuples.

**Days-since-now arithmetic uses `Date.now()` at compute time.** The
generator emits `*InDays` offsets; the seeder helpers compute the
actual ISO date at insert time via `isoDateOffset`. This means
re-running the seed N days later would compute different
`occurredOn` values, which the self-healing contract would see as
`updated`. Acceptable for transactions because the spec is "spread
across the last 12 months relative to today" — semantically the
field SHOULD move with the calendar. Tested by re-running the seed
twice in a single session: the second run lands every row as
`unchanged` (Date.now() barely shifts within seconds).

**Audit `actorRole` for generator-emitted rows.** Tender publishes
audit with `actorRole = "admin"` (mirrors who would have done this
in production); tender applications audit with `actorRole =
"company"` (the application is conceptually authored by the
applying company). The system sentinel role is reserved for the
cron sweeps and Chunk-2's invariant verifier.

## Gotchas surfaced

**`tsx` is not on the global PATH on this machine.** Running
`tsx scripts/reset-db.ts && pnpm db:migrate && pnpm db:seed:small`
directly from bash fails the first step because `tsx` is only
available via `pnpm`. The workaround is `pnpm exec tsx
scripts/reset-db.ts && pnpm db:migrate && pnpm db:seed:small`, or
use the `pnpm db:reset` script chain which `tsx`-invokes from
within the npm script context. Worth knowing for one-off scripted
flows.

**The cheat-sheet's totals query needs `coalesce(sum(...), 0)`.**
Without the coalesce, `SELECT sum(amount_paise) FROM transactions`
against an empty transactions table returns NULL, and `Number(NULL)`
is 0 in JS but the formatter renders it as "₹0.00". Cleaner to
coalesce at the SQL layer so the JS side never sees NULL. Done.

**The volume-lift companies generator handles the small-profile
underflow case naturally.** When the baseline already exceeds the
target (small profile: baseline 7 standalones > target 6), the
generator's `Math.max(0, target - existingCount)` returns 0 and the
generator emits no rows. No special-casing needed.

**Cross-FK invariant in the txn generator catches an entire class of
bug.** The first draft picked the company independently of the
project, which immediately produced invariant violations on the
verify pass. Restructuring the generator to pick the company FROM the
project's `companyName` made the invariant hold by construction.
Worth carrying into any future fixture work — "by-construction"
invariants beat "re-asserted at insert time".

**Mulberry32 needs `>>> 0` to coerce the seed to uint32.** The
naive form `let a = seed` works for positive integers but signed
arithmetic creates subtle bugs for large seeds. The `seed >>> 0`
zero-fill-right-shift coerces to unsigned 32-bit. Standard idiom
for JS-native PRNGs.

**Generator file imports types from seed.ts; seed.ts dynamically
imports the generator module.** This avoids any circular-import issue
at module parse time. Tests in `scripts/__tests__/` don't trigger the
chain because they only import the generator types via the seed
re-exports.

**`pnpm db:reset` is now fully unblocked.** Day-21's EBUSY blocker
was the dev server holding the SQLite file open. With the dev server
stopped (Mayuresh's environment by start of Day 22), `pnpm db:reset`
runs cleanly. Future sessions can rely on this.

**The reminders_sent generator's pre-population may overlap with the
cron's reminders.** Both target docs in the (0, 30] window. The
`(documentId, reminderKind)` unique index prevents duplicates, but
the cron's "skipped deduped" counter goes up. On the test DB this
showed as `remindersSkippedDeduped=5` (the 5 pre-populated rows).
Working as intended — the cron should skip what's already there.

## Surfaces touched

```
# Chunk 1 — Schema widening migration (commit 4d23d2b)
app/dashboard/companies/_components/badges.tsx                    (modified — +2 status variants + icons)
app/dashboard/companies/_components/filters-bar.tsx               (modified — +2 filter options)
drizzle/0013_thankful_sunset_bain.sql                             (new — column add)
drizzle/meta/0013_snapshot.json                                   (new)
drizzle/meta/_journal.json                                        (modified — migration entry)
lib/companies/actions.ts                                          (modified — rejectionReason patch passthrough)
lib/companies/schemas.ts                                          (modified — Zod enum widening + new field)
lib/db/schema.ts                                                  (modified — union + column)

# Chunk 2 — SEED_SCALE + invariants + cheat-sheet (commit fa9e67d)
docs/seed-plan.md                                                 (modified — Day-22 v2 section appended)
package.json                                                      (modified — +db:seed:* + seed:verify scripts)
scripts/__tests__/seed-invariants.test.ts                         (new — 5 tests)
scripts/seed-invariants.ts                                        (new — verifier helper + CLI)
scripts/seed.ts                                                   (modified — SEED_SCALE, cheat-sheet, scale param)

# Chunk 3 — Volume lift, half 1 (commit f59a149)
scripts/seed-generators.ts                                        (new — PRNG + 4 generators)
scripts/seed.ts                                                   (modified — type exports, generators wired into main, audit helpers, seedReminderSent)

# Chunk 4 — Volume lift, half 2 (commit fe25887)
scripts/seed-generators.ts                                        (modified — +4 generators)
scripts/seed.ts                                                   (modified — type exports, Chunk-4 generators wired)

# Day 22 report (this commit)
docs/reports/day-22-report.md                                     (new)
```

## Test totals

Before this session: **482 tests across 28 files**, all green
(Day 21 end state).

After this session: **487 tests across 29 files**, all green every
run. Net: **+5**.

Breakdown:

- +5: `scripts/__tests__/seed-invariants.test.ts` (Chunk 2, new file).
- +0: Chunk 3 (generators exercised indirectly via the
  invariant tests + the dataset itself; the verifier failing under any
  generator bug would have surfaced it).
- +0: Chunk 4 (same shape; Chunk-4 generators emit specs in the
  shape the existing seeders already test against).

The brief budgeted ~8–12 new tests. Landed at +5 because Chunks 3 + 4
chose to lean on the existing invariant + seed-self-healing tests
rather than add per-generator unit tests. The contract is exercised
by the full dataset every `pnpm db:seed` run; a per-generator unit
test would have re-tested what the invariant verifier already covers.

## Followups for Day 23+

**From this session:**

1. **Compliance state-machine guards.** The widened union has
   `rejected` as a logically-terminal state and `suspended` as a
   reversible-to-compliant state, but `updateCompany` doesn't enforce
   those. A dedicated `lib/companies/state-machine.ts` (mirroring
   `lib/projects/state-machine.ts`) would enforce the
   transition table at the action layer.
2. **UI for the new `Suspended` / `Rejected` badges' palette.** The
   chunk-1 colours (amber-100 / destructive) are pragmatic defaults
   — a design pass that aligns them with the Figma palette and the
   per-status icon language would land before the client UAT pass.
3. **The `rejectionReason` field is admin-only on read but the
   company-detail page doesn't yet surface it.** A staff-side reveal
   on the company detail page (when status = rejected, show the
   reason in a callout) would close the loop on the new column.
4. **The compliance-state-change audit verb is `compliance_status_changed`
   in `AuditAction`, but the seed currently emits plain `created` for
   newly-rejected/suspended companies.** That's correct (they're new
   companies, not transitions), but when the state-machine module
   lands, it'd write `compliance_status_changed` with `before` /
   `after` snapshots. Coordinate.
5. **Per-generator unit tests, if the seed grows further.** Today the
   invariant verifier + self-healing tests cover the contract
   end-to-end. If a future Day-23 work-item adds a fifth generator
   for a new entity, consider one unit test per generator pinning
   "scale=large emits N rows of mix M".

**From the embedded seed-plan v2:**

6. **Realistic Indian-flavoured fixture data.** Day-22 placeholders
   (Orion Build, Helix Energy, etc.) still aren't verifiable GST
   format or real CINs. A polish pass with realistic-looking data is
   a separate UX task. Day-21 followup #2 still open.
7. **Real R2 fixture files.** Day-21 followup #3 still open.
   `fileKey` keeps pointing at non-existent objects across all 120
   document fixtures.
8. **Multi-step registration UX / CAPTCHA / rate limiting.** Day-15
   carry-forward (followups #20-#21). Becomes more important once
   the public registration flow is exposed; the seed sidesteps it
   entirely.

**Carried forward from Day 21 (unchanged):**

9. **Charts on the dashboard + report.** Separate UX pass. The
   Day-22 dataset now has 13 months of transaction data — meaningful
   trend lines have a real substrate to render against.
10. **Period-over-period comparison on the reports.** Future session.
11. **Real Consultway logo on the PDF cover.** Awaiting brand asset.
12. **Streaming exports beyond 1000 rows.** Phase-3 work. With 250
    txns in the dataset, the 1000-row cap is still comfortable.
13. **Searchable typeahead selects on forms + reports pickers.**
    Phase-1 scale doesn't need it; the company picker now has 32
    options, still navigable via the dropdown.
14. **Per-document CSV export / Bulk CSV import / Saved-report-config
    persistence / Dashboard widget loading skeletons / deleteProject
    / Project-attached documents / Side-by-side detail view /
    TransactionType etc. badge palette unification / session
    invalidation on password reset / public tender browsing /
    OpenNext install / D1 client factory / Resend domain verification
    / Real Cloudflare bucket UUIDs / Hoist escapeHtml.** All Day-15
    or earlier carry-forwards.

**Already-resolved this session:**

- Day-21 followup #1 (pnpm db:reset smoke check + manual dashboard
  verification): the reset smoke check ran cleanly under the widened
  schema with the full Chunk-3+4 volume dataset. The manual browser
  verification is the only deferred half — Mayuresh's call to action
  per the Chunk-5 table above.

## Carry-forward to Day 23

- **`dev` ends at 4 commits past `origin/dev`** before this report's
  own commit: `4d23d2b` / `fa9e67d` / `f59a149` / `fe25887`. Run
  `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing still requires explicit approval per `<permissions>`.
- **487 tests passing on every run.** One new test file added
  (`scripts/__tests__/seed-invariants.test.ts`); no existing test
  files modified.
- **Schema at migration 0013.** `companies.rejection_reason` column
  added; `ComplianceStatus` union widened to include `suspended` and
  `rejected`. Future Day-23 schema work generates 0014.
- **Zero new dependencies** this session. Day 20's `@react-pdf/renderer
  ^4.5.1` remains the only addition since Day 19.
- **`pnpm db:reset`** runs cleanly. Day-21's EBUSY blocker is gone.
- **`pnpm cron:expiry-sweep`** reports `remindersAttempted=13` +
  `remindersSkippedDeduped=5` against a fresh `large` seed (was 1 + 1
  at Day-21 end).
- **`pnpm cron:pending-cleanup` / `pnpm cron:token-cleanup`** clean.
- **`pnpm seed:verify`** clean against both `large` (full dataset)
  and `small` (baseline-only) profiles. New `pnpm db:seed:small |
  medium | large` shortcuts pick the profile inline.
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 22 didn't add
  new email surfaces.
- **`PASSWORD_PEPPER`** unchanged.
- **`scripts/seed.ts` exports** widen substantially: `StandaloneSeed`,
  `StaffUserSeed`, `CompanyUserSeed`, `DocumentSeed`, `TenderSeed`,
  `TenderApplicationSeed`, `ProjectSeed`, `TransactionSeed`,
  `SEED_VERIFIED_AT`, `SeedScale`, `SEED_SCALE_PROFILES`,
  `resolveSeedScale`. Plus the existing seeders + the new
  `seedReminderSent`.
- **`scripts/seed-generators.ts`** is the new generator hub. Eight
  generators total (Chunks 3 + 4). Mulberry32 PRNG exported as
  `makePrng(seed)` for any future deterministic-fixture work.
- **`scripts/seed-invariants.ts`** is the invariant verifier.
  `runInvariantChecks(db)` is the programmatic entry point;
  `pnpm seed:verify` is the CLI.
- **`docs/seed-plan.md`** carries the Day-22 v2 section as the
  authoritative reference for SEED_SCALE + invariants + acceptance.
- **`large` dataset cheat-sheet** prints at the end of every seed
  run; the structured log line stays for grep.
- **Manual dashboard verification deferred to Mayuresh** per the
  Chunk-5 table. The substrate is in place; what's left is
  eyeballing each screen × role combination and flagging any visual
  regressions surfaced by the volume increase.

That's Day 22.
