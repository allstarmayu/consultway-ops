# Day 14 — Application notifications, award winner column, list query SQL cleanup

_Date: 2026-05-23_

## Scope

Three deliverable chunks, each its own commit on `dev`, closing
followups #9 (listTenders approximation) and the Phase-2-deferred
awardedCompanyId column, and landing the obvious next surface for
the Day-10 transactional email pipe (Application status →
applicant inbox):

1. **Application status notifications.** Shortlist + reject now fire
   an email to the applying company. Templates mirror the existing
   expiry-reminder shape; routes through the `lib/email/client`
   dual-path so the work lands testable without a Resend account.
2. **`awardedCompanyId` column on tenders.** Drizzle migration adds
   the column the `markAwarded` action has wanted since Phase 1
   landed. UI gains a Select-based winner picker; tests pin the
   symmetric clear-on-retract behaviour.
3. **`listTenders` SQL OR refactor.** Replaces the JS post-filter
   for company-role visibility with a real `or(...)` clause. The
   approximate-by-N total is now exact.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` 272/272 green every run (was 248; +24 net),
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean
against the dev DB after migration 0008 applied.

## What shipped

### Chunk 1 — Application status notifications (commit `7f5368f`)

**Two new email templates under `lib/email/templates/`:**

- `application-shortlisted.ts` — `renderApplicationShortlistedEmail({
  application, tender, company, appUrl })` returning the standard
  `{ subject, html, text }` triplet. Subject: `Your application for
  "<title>" has been shortlisted`. Copy leans actively positive but
  qualifies the news ("under final consideration", not "you've won")
  — being shortlisted advances the application; it doesn't guarantee
  the award.
- `application-rejected.ts` — same shape. Subject deliberately reads
  `Update on your application for "<title>"` rather than including
  the word "rejected" — too blunt for a transactional header.
  Body uses "not selected for this opportunity" rather than "we're
  sorry to inform you" / "you didn't qualify" — keeps the door open
  for future bids. `internalNotes` is NEVER included in the
  customer-facing email; tests pin this so a future "let's surface
  the reason to the applicant" change has to consciously cross that
  line.

Both templates use the same inline-style + table-layout convention as
`document-expiry-reminder.ts`. Inline `escapeHtml` is duplicated
across templates rather than lifted to a shared helper — six lines per
template, no shared coupling, easier to delete if a template ever
needs different escaping.

**`updateApplicationStatus` wiring (`lib/tenders/actions.ts`):**

After the status flip and audit event, the action calls a new
`notifyApplicantOfStatusChange` helper that:

1. Parallel-fetches the tender (id, title, referenceNumber,
   closingDate) and the applying company (id, name, contactEmail)
2. Bails (logged at warn) when any prerequisite is missing — tender,
   company, or contactEmail
3. Renders the right template based on the new status
4. Sends via the injected `sendEmail`
5. Logs `ok:false` results at warn level but does NOT propagate to
   the caller — the status flip already succeeded and is the
   load-bearing fact. The convention matches the expiry-sweep cron.

The action is now `updateApplicationStatus(input)` (public Server
Action, uses production `sendEmail`) wrapping
`updateApplicationStatusInternal(input, { sendEmail })` (exported for
tests). Mirrors the `runExpirySweep` DI pattern — `vi.mock` stays
scoped to the auth boundary; the email boundary is an honest
parameter.

A `try/catch` around the entire notifier defends against an
unexpected throw from the email path (network blip, Resend SDK
contract drift). Caller never sees the throw; logged at error level
for forensics.

**Day-5 reversals deliberately don't email:**

- `reinstateApplication` (staff-driven undo of a shortlist/reject) —
  the applicant didn't ask for it; the audit trail is the right
  channel for staff visibility.
- `recallApplication` (company recalling own withdrawal) — the
  applicant IS the actor; no need to email themselves.
- `withdrawApplication` (company withdrawing own submission) — same
  reasoning as recall.

Pinned with a dedicated test ("reinstateApplication does not notify
applicant") that asserts reinstate succeeds without any email path.

**Tests in `lib/tenders/__tests__/application-actions.test.ts`
(+7):**

- shortlist sends shortlisted email to the right address with the
  right subject; body contains the company name
- reject sends rejected email; subject reads "Update on", NOT
  "rejected"; internalNotes don't leak into html OR text body
- email send returning `ok:false` does NOT reverse the status flip
- email throwing inside sendEmail does NOT throw out to the caller
- withdrawn applicant: status gate fires first, sendEmail never
  called
- idempotent same-status no-op: sendEmail never called
- reinstate: succeeds without touching the email client

172 → 255 → fine, that's previous Day 13's baseline. This session's
baseline 248; after Chunk 1 = 255 tests passing.

### Chunk 2 — `awardedCompanyId` column (commit `fd8969e`)

**Schema (`lib/db/schema.ts`):**

- `tenders.awardedCompanyId` (TEXT NULLABLE, FK → `companies.id` ON
  DELETE RESTRICT, ON UPDATE NO ACTION). Restrict semantics match
  `publisherCompanyId` — losing the winner's identity would break
  audit, so admins must move the tender away from awarded (or
  retract) before they can delete the winning company.
- New `tenders_awarded_company_id_idx` for reverse lookups
  ("what did Acme win"). Phase 3's tender → project flow will be the
  primary consumer; the index also makes "what tenders has this
  company won" cheap on the eventual company detail panel.

**Migration `drizzle/0008_luxuriant_doorman.sql`:**

`pnpm db:generate` produced the column + index but **omitted the ON
DELETE RESTRICT clause** from its ALTER TABLE ADD COLUMN — drizzle-kit's
generator emits a bare `REFERENCES companies(id)` for added FK
columns in SQLite even though the dialect supports the cascade
keywords inline. Restored by hand to match the schema declaration.
Applied locally via `pnpm db:migrate`; no remote DB touched.

**`markAwarded` action (`lib/tenders/actions.ts`):**

- Input shape changed from `(rawId: string)` to
  `{ tenderId, awardedCompanyId }`. Both ids required. Old call
  sites that passed a bare string id surface as `ok: false` via Zod
  refusal — tested. The action signature stays
  `(rawInput: unknown)` so this is a runtime-only breaking change,
  not a type-system one.
- New gate order:
  1. AuthZ (admin/staff)
  2. Schema (both ids well-formed)
  3. Tender exists + is in `closed` status (returns clearer error
     than the state machine alone would)
  4. Named company has an application on this tender AND it is in
     `shortlisted` status
  5. Delegates to `transitionTenderStatus` with patch override
     `{ awardedCompanyId: input.awardedCompanyId }`

The shortlist-only requirement is intentional friction: awarding to
a non-shortlisted bid skips the evaluation checkpoint. If a
procurement decision lands on a previously-rejected applicant, staff
have to reinstate-then-shortlist first — the audit trail captures
the rationale.

**`retractAward` action:** delegates with patch override
`{ awardedCompanyId: null }`. Pinned in tests — the column must
clear so a retracted tender genuinely has no winner anymore.

**`transitionTenderStatus` extension:** grew a 6th parameter
`patchOverrides?: Partial<typeof tenders.$inferInsert>`. Folded into
the DB patch AFTER the status-and-publishedAt computation so callers
can't accidentally override the status flip itself. The before/after
audit snapshots now also include `awardedCompanyId` when the column
is touched.

**UI (`app/dashboard/tenders/[id]/_components/tender-header.tsx`):**

Added a `shortlistedApplicants: ShortlistedApplicantOption[]` prop.
The markAwarded button now renders inside a small flex group with
a `<Select>` of candidates immediately to its left. When the
candidate pool is empty (no shortlisted applications), the Select is
replaced by a muted hint "Shortlist an applicant first to award this
tender" and the button stays disabled. The ConfirmDialog description
includes the chosen company's name once a selection is made.

`app/dashboard/tenders/[id]/page.tsx` derives the candidate list from
the already-loaded applications array — no extra DB roundtrip.

**Tests in `state-machine.test.ts` (+3 net):**

- markAwarded happy path asserts the column populates
- Refusal when the named company has no application (`field:
  "awardedCompanyId"`, error matches `/no application/i`)
- Refusal when the application isn't shortlisted (`field:
  "awardedCompanyId"`, error matches `/shortlisted/i`)
- Zero-arg legacy `markAwarded(stringId)` surfaces as `ok: false`
- End-to-end pipeline updated to seed + shortlist the applicant
  before close + award, AND asserts the column populates mid-
  pipeline then clears on retract
- retractAward test seeds with `awardedCompanyId` pre-populated;
  asserts the column clears to NULL post-retract; asserts the audit
  before/after snapshots capture the column transition

**Doc sync (`docs/05-database-schema.md`):**

Added the `awarded_company_id` row + index entry to the tenders
table. Also flagged the broader Phase-1-spec-vs-code drift on this
table (e.g. the doc still lists `slug`, `sector_tags`,
`eligibility_rules` JSON, `closes_at`, etc. — none of which match
the implemented schema). Per `CLAUDE.md`'s "code wins" rule, the
column-spec sync was the in-scope change; the rebaseline is a
separate followup.

### Chunk 3 — `listTenders` SQL OR refactor (commit `db282be`)

**`lib/tenders/actions.ts::listTenders`:**

Pre-Day-14, the company-role no-status-filter branch fetched the
page with an unscoped WHERE then filtered drafts-not-owned-by-the-
caller in JS post-fetch. The `total` came from the SQL count and was
adjusted by the JS-filtered-out count — making it accurate only for
the current page's contents. A caller paginating across multiple
pages would see the total decrement as foreign drafts on later pages
were discovered.

Replaced with a Drizzle `or(...)` directly in the WHERE:

```ts
or(
  ne(tenders.status, "draft"),
  eq(tenders.publisherCompanyId, scope.scopeCompanyId),
)
```

The `total` now comes straight from the indexed SQL count. The JS
post-filter is gone; the JS-only `let rows / let total` machinery is
gone. Total is `totalRow?.value ?? 0`, full stop.

The branch table for company-role callers, now baked entirely into
SQL:

| status filter | WHERE clause                                  |
| ------------- | --------------------------------------------- |
| none          | `(status != 'draft') OR (publisher = own)`    |
| `'draft'`     | `status = 'draft' AND publisher = own`        |
| other status  | `status = <other>`                            |

The "explicit status=draft for company-role" branch was already
correct (filtered both status AND publisher) — kept verbatim.

**New file `lib/tenders/__tests__/list-visibility.test.ts` (+14
tests):**

Fixture seeds 8 tenders across three publishers with varied
statuses, sectors, and geographies. Coverage:

- admin sees all 8; staff sees all 8 (no scope clause applies)
- admin filtering by status=draft sees all 3 drafts (no scope)
- companyA / companyB each see exactly 6: their own draft + all 4
  Consultway non-drafts + the 1 Acme published; foreign drafts
  invisible
- explicit `status=draft` for companyA returns only Acme's draft
  (1 row); same for companyB
- explicit `status=published` for companyA returns all 3 published
  (2 Consultway + 1 Acme)
- `internalNotes` stripped for company-role even on the SQL-side
  visible rows
- Layered sector=Infrastructure filter for companyA returns exactly
  the 4 Infrastructure tenders visible to them (composes correctly)
- Layered geography=Karnataka for companyB returns the 2 KA tenders
  visible to them (Consultway pub + own draft)
- Layered search=Acme for companyA returns the 2 Acme-titled
  tenders (incl. own draft); for companyB returns 1 (just the
  published Acme; the Acme draft is invisible)
- Pagination: 6 visible, perPage=3 → 3 rows, total=6 (the exact
  case where the old JS post-filter would have been wrong)

The fixture's visibility totals (admin: 8, company: 6) are
load-bearing arithmetic — counted carefully so future test edits
don't accidentally shift them.

258 → 272 tests, +14.

## Key decisions

**Email injection via an exported internal helper, not module
`vi.mock`.** The brief said to mirror the cron's DI pattern — `vi.mock`
would have worked but couples the test to the import resolver. The
exported `updateApplicationStatusInternal({ sendEmail })` makes the
dependency explicit at the test call site and keeps the production
action wrapper paper-thin.

**Reject email subject avoids the word "rejected".** "Update on your
application for X" reads as neutral correspondence; "Your application
for X has been rejected" lands as a slap in the inbox preview. The
body delivers the news directly ("not selected for this opportunity")
— softening that would feel evasive — but the header is the first
thing a recipient sees and the wrong tone there is unrecoverable.

**Notification failure is fail-soft, not fail-loud.** Same convention
as the expiry-sweep cron: the audit-relevant decision (status flip,
audit row, log line) already landed before the notify path runs.
Reversing it because the network blipped on the way to Resend would
turn a transient network failure into a permanent decision regression.
The log surfaces the failure for forensic follow-up.

**Day-5 reversals deliberately don't email.** Reinstate, recall,
withdraw are either staff-driven undo (no applicant action to
acknowledge) or applicant-driven (no need to confirm to themselves
what they just did). The audit trail is the source of truth; emails
that say "Your application was reinstated by a staff member" would
be noise. Pinned with a test ("does not notify applicant") so a
future "let's notify on everything" PR has to consciously override.

**`awardedCompanyId` is FK-RESTRICT not CASCADE.** Same precedent as
`publisherCompanyId`. The audit log captures the historical award
fact even if the row eventually goes; the foreign key keeps the live
tender row internally consistent. An admin who needs to delete a
winning company has to retract the award first — that retraction is
a documented user-facing action with its own confirm-dialog and
required reason, exactly the right signal.

**markAwarded requires a shortlisted applicant, not just any
applicant.** The shortlist step exists for a reason — it represents
"staff have evaluated this submission and consider it award-eligible".
Skipping straight to awarding a submitted-but-not-yet-evaluated bid
(or worse, a rejected one) would erase the evaluation checkpoint.
Friction here is the feature: staff reinstate-then-shortlist if the
decision lands on a previously-rejected company, and the audit log
captures every step.

**Hand-fix to drizzle-kit's migration over re-generating.** The
generator omitted the cascade clauses. Re-generating would have
produced the same defective SQL; there's no obvious config flag to
flip. Hand-edit was the minimal, audited fix; the schema
declaration in `lib/db/schema.ts` is the source-of-truth that next
session's tests will re-verify if anything drifts.

**`patchOverrides` is the sixth parameter on
`transitionTenderStatus`, NOT a top-level `awardedCompanyId` arg.**
Open-extensibility — if a future transition needs to write yet
another column alongside the status flip (Phase 3's `closedAt` /
`awardedAt` timestamps come to mind), the helper signature stays
stable; the caller passes whichever fields it needs.

**SQL OR clause via Drizzle's `or(...)` even though `or()` can return
`undefined`.** Both inputs to the `or` are known-non-null `SQL`
expressions at the call site, so the `!` assertion is safe. Building
the WHERE imperatively (`filters: SQL[]`) keeps the structure
readable; the alternative was to drag a `whereClause: SQL |
undefined` accumulator through the whole function.

**14 list-visibility tests over the 8-12 budget.** The layered-filter
cases (sector / geography / search × visibility scope) needed their
own assertions because the old approximation was at its worst when
visibility and content filters were applied together — getting all
six combinations right is the actual contract. The pagination test
covers the specific scenario the comment was warning about.

## Gotchas surfaced

**drizzle-kit's ALTER TABLE ADD COLUMN drops FK cascade clauses.**
Documented in Chunk 2; the generator emits `REFERENCES tbl(col)`
without `ON DELETE ...` for added columns. CREATE TABLE statements
get the clauses correctly. Any future single-column FK additions
need the same hand-edit; a multi-column or table-rebuild migration
would be regenerated cleanly. Worth filing as a drizzle-kit issue
when this happens twice.

**`@ts-expect-error` on `markAwarded(stringId)` would have been
wrong.** Server Actions take `(rawInput: unknown)`, so the
TypeScript type system happily accepts a string. The Day-14 breaking
change is runtime-only (Zod) — the test exercises the runtime
refusal, not a compile-time one. Caught when tsc surfaced "unused
@ts-expect-error directive" on the first compile. Comment in the
test now explicitly notes this.

**Counting visible rows by hand is error-prone.** Initial fixture
asserted 7 visible per company-role caller; the math was actually 6
(4 Consultway non-drafts + 1 Acme published + 1 own draft = 6, not
7 — I'd accidentally counted Consultway's draft once). Caught by the
first test run. The fix wasn't a behaviour change, just the
assertion count. Pre-counting the fixture's visibility table in the
docstring comment up front would have caught this before the first
red — folded that into the file's top docstring.

**Existing tests that touched `markAwarded` had to be migrated, not
just left alone.** Four call sites in `state-machine.test.ts` used
the old `markAwarded(id)` shape. The new schema would reject all of
them. Updated each to pass `{ tenderId, awardedCompanyId }` AND seed
a shortlisted application — the application setup is now part of the
"this test exercises the award path" contract.

**The `published_at` is preserved on retract.** A retracted-then-
re-awarded tender still has its original publishedAt — the column
is "when did this first go live", not "how long has it been
awarded". This was already the case pre-Day-14 (`retractAward` just
calls `transitionTenderStatus` without touching publishedAt) but
worth noting since the symmetric column-clear pattern might tempt a
future change to clear publishedAt on retract too. Don't.

**Email helper queries `companies.contactEmail`, but companies don't
have to have one.** The notifier bails (logged at warn) when
`contactEmail` is null. This is fine for fixture-driven tests where
contactEmail is always set — and it's the right production behaviour
(a company with no contact email simply doesn't get notified; staff
follow up via WhatsApp / phone). Worth confirming on the next
real-data smoke run that production fixtures have contactEmail
populated.

## Surfaces touched

```
# Chunk 1 — Application status notifications (commit 7f5368f)
lib/email/templates/application-shortlisted.ts                      (new)
lib/email/templates/application-rejected.ts                         (new)
lib/tenders/actions.ts                                              (modified - updateApplicationStatus wrap + notifyApplicantOfStatusChange)
lib/tenders/__tests__/application-actions.test.ts                   (modified - +7 tests)

# Chunk 2 — awardedCompanyId column (commit fd8969e)
lib/db/schema.ts                                                    (modified - new column + index)
drizzle/0008_luxuriant_doorman.sql                                  (new - hand-edited for FK cascade)
drizzle/meta/0008_snapshot.json                                     (new - drizzle-kit generated)
drizzle/meta/_journal.json                                          (modified - drizzle-kit generated)
lib/tenders/schemas.ts                                              (modified - new markAwardedSchema)
lib/tenders/actions.ts                                              (modified - markAwarded rewritten; transitionTenderStatus patchOverrides param; retractAward clears column)
lib/tenders/__tests__/state-machine.test.ts                         (modified - +3 net tests; existing tests migrated)
app/dashboard/tenders/[id]/_components/tender-header.tsx            (modified - winner picker UI)
app/dashboard/tenders/[id]/page.tsx                                 (modified - shortlistedApplicants prop)
docs/05-database-schema.md                                          (modified - tenders table column sync + drift note)

# Chunk 3 — listTenders SQL OR refactor (commit db282be)
lib/tenders/actions.ts                                              (modified - listTenders WHERE rewrite; JS post-filter removed)
lib/tenders/__tests__/list-visibility.test.ts                       (new - 14 tests)

# Day 14 report (this commit)
docs/reports/day-14-report.md                                       (new)
```

## Test totals

Before this session: **248 tests across 10 files**, all green (Day
13 end state).

After this session: **272 tests across 11 files**, all green every
run. Net: **+24**.

Breakdown of the delta:

- +7: `application-actions.test.ts` (Chunk 1 — email notifications
  + reinstate-no-email)
- +3: `state-machine.test.ts` (Chunk 2 — markAwarded requires winner
  + zero-arg refusal + retractAward column clear assertions)
- +14: `list-visibility.test.ts` (Chunk 3 — new file)

The brief budgeted ~15-30 new tests; landed at +24, smack in the
middle. The over-run on Chunk 3 (14 vs 8-12 budget) reflects the
layered-filter coverage — each (visibility × content filter)
combination is its own clear assertion.

## Followups for Day 15+

**From this session:**

1. **drizzle-kit ALTER TABLE ADD COLUMN omits FK cascade clauses.**
   Filed in Gotchas above. If a third hand-edit is needed for a
   future migration, worth filing as an upstream issue.
2. **`docs/05-database-schema.md` tenders table is broadly out of
   sync with `lib/db/schema.ts`.** Phase-1 spec snapshot listed
   `slug`, `sector_tags`, JSON `eligibility_rules`, `closes_at`,
   `created_by` — none match the code. Day 14 added the new column
   row but didn't rebaseline the rest; that's a dedicated doc-pass
   session.
3. **Tender publish / withdraw / unpublish / recall notifications.**
   Chunk 1 confined the email surface to shortlist/reject by
   design. Broadening it (publish-with-open-deadline → notify
   sector subscribers? unpublish → notify existing applicants?) is
   a Day-15 design call.

**Deployment wiring (carry-forward, still gated on dep install):**

4. **`@opennextjs/cloudflare` install + `open-next.config.ts`.** Same
   as Day 13 — the scheduled handler module exists, the re-export
   step lands when the dep gets installed.
5. **D1-backed Drizzle client factory.** Same shape as Day 13's
   followup #2.
6. **Resend domain verification + production secret.** Procedure
   lives in `docs/09-deployment.md` § 3.5.
7. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
   Still `REPLACE_WITH_*` placeholders.

**Cleanup / nice-to-have (carry-forward):**

8. **Side-sheet vs side-by-side detail view at desktop widths**
   (Day 11+ followup). Carry-forward.
9. **Seed self-healing on changed fixtures** (Day 11 followup).
   Carry-forward.
10. **Stage real fixtures into R2** for demo download paths.
    Carry-forward.
11. **`__drizzle_migrations` tracker note in contributing doc.**
    Carry-forward from Day 13.
12. **`process.env.NODE_ENV` cast in `vitest.setup.ts`**.
    Carry-forward.

**Already-resolved this session:**

- Day 13 followup #9 (listTenders approximate total) — closed as
  Chunk 3. The SQL OR clause replaces the JS post-filter; total is
  now exact.
- Long-standing Phase-2 deferral on `awardedCompanyId` — closed
  as Chunk 2. The column lives; markAwarded uses it; retractAward
  clears it; UI picks the winner; doc updated.

## Carry-forward to Day 15

- **`dev` ended at 4 commits past Day 13's final state** (Day 13's
  report commit was `0716fdf`; this session's commits are
  `7f5368f` / `fd8969e` / `db282be` plus this report's commit).
  Run `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing still requires explicit approval per `<permissions>`.
- **272 tests passing on every run.** Three test files touched
  (extended application-actions, extended state-machine, added
  list-visibility); no flakes observed across the session's runs.
- **Migration 0008 applied to dev DB.** `awarded_company_id` column
  + index present. `pnpm db:reset` would rebuild from scratch
  correctly via the migrations chain. The Day-12 drift class did
  not surface this session.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` from the Day-12 dedup row for Acme
  Mumbai trade license at slot T-30. Expected; not a regression.
- **`pnpm cron:pending-cleanup`** clean (`deletedCount=0`).
- **`RESEND_API_KEY` still empty** in `.env.local` — Chunk 1's new
  emails go through log-fallback. Production wiring is the
  deployment session's task.
- **`PASSWORD_PEPPER=dev-only-pepper-replace-in-prod`** still in
  `.env.local`. Do NOT change without re-seeding.
- **Phase 3 (project tracking) now has its bridge column.**
  `tenders.awardedCompanyId` is the read for "what should this
  project's company be when we create it from a closed tender?"
- **`markAwarded` is now a breaking-input-shape change.** Any
  external callers (none currently — purely UI-driven) need
  `{ tenderId, awardedCompanyId }`. Documented in the migration
  doc and codified in tests.

That's Day 14.
