# Day 13 — Cron wiring, tender test coverage, email env scaffolding

_Date: 2026-05-23_

## Scope

Three deliverable chunks, each its own commit on `dev`, closing
followups from Day 12 ahead of the deployment session that will
actually push to Cloudflare:

1. **Cron `scheduled()` handler + second trigger.** The local cron
   scripts (`pnpm cron:expiry-sweep`, `pnpm cron:pending-cleanup`) ran
   the same handlers production will run, but nothing tied the
   handlers to Cloudflare's scheduler. This chunk lands the dispatch
   module and the second `wrangler.jsonc` trigger.
2. **Tender test coverage.** `lib/tenders/__tests__/` was empty
   despite ~14 fully-wired Server Actions including non-trivial Day-5
   reversals. Three new test files lock the behaviour before further
   changes land.
3. **Email env scaffolding + Resend deployment doc.** `wrangler.jsonc`
   was missing `EMAIL_FROM` / `EMAIL_REPLY_TO` vars and the deployment
   doc had nothing on Resend domain verification. Closed both.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` 248/248 green every run (was 172; +76 from Chunk 2),
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean
against the seeded dev DB.

## What shipped

### Chunk 1 — `scheduled()` handler + pending-cleanup trigger (commit `fcce37e`)

`lib/crons/scheduled-handler.ts` (new) — single `scheduled({ cron,
scheduledTime })` entry that dispatches on the cron string:

- `"0 2 * * *"` → builds the `ExpirySweepDeps` (same shape
  `scripts/cron-expiry-sweep.ts` builds: real `db`, child logger,
  `sendEmail`, `env.NEXT_PUBLIC_APP_URL`, today as
  `YYYY-MM-DD` from `new Date().toISOString().slice(0, 10)`) and
  awaits `runExpirySweep`.
- `"0 3 * * *"` → builds `PendingCleanupDeps` (db, logger, `now` from
  `new Date().toISOString()`) and awaits `runPendingCleanup`.
- Anything else → warn + no-op. Adding a third trigger is a fourth
  case + one more entry in `wrangler.jsonc`.

Failure handling is `try/catch` at the top level: any thrown error
gets logged with the cron string + duration and swallowed. Cloudflare
treats a thrown error as a failed invocation that surfaces in the
dashboard and can page someone; the underlying handlers (`runExpirySweep`
/ `runPendingCleanup`) already report results through their structured
`Result` types and write per-row errors to the logger, so a top-level
throw would double-count as both a per-row error AND a worker failure.
Swallowing keeps the forensic trail without paging.

The dispatch table uses string-literal constants
(`CRON_EXPIRY_SWEEP`, `CRON_PENDING_CLEANUP`) so the switch compares
statically and a typo is a TypeScript error rather than a silent
unknown-cron branch.

`wrangler.jsonc` — `triggers.crons` extended to `["0 2 * * *",
"0 3 * * *"]`. Comment above the block points at this report's
followup for the OpenNext re-export step (see below).

**OpenNext caveat.** The brief asked for an `open-next.config.*`
that re-exports `scheduled` from the new module. `@opennextjs/cloudflare`
isn't in `package.json` (the deployment doc references it
aspirationally but the build artifact `.open-next/worker.js` doesn't
exist locally either), and "no new deps" was an explicit out-of-scope
rule for this session. The scheduled handler is the load-bearing
piece (importable + testable as is); the OpenNext re-export step lands
when the dep gets installed in the deployment session. Flagged in
Followups below.

**Smoke verification.** Both local cron scripts ran cleanly post-
refactor:

- `pnpm cron:expiry-sweep` → `remindersSkippedDeduped=1` (the Day-12
  dedup row from yesterday's slot is still doing its job), no errors.
- `pnpm cron:pending-cleanup` → `deletedCount=0` (no orphan pending
  rows accumulated since Day 12's seed).

172 tests passing on this commit (no test additions).

### Chunk 2 — Tender test coverage (commit `5b87b4d`)

Three new files under `lib/tenders/__tests__/`, fixture pattern
mirroring `lib/documents/__tests__/expiry-sweep.test.ts`:

**`state-machine.test.ts` (35 tests).** Lifecycle transitions across
every legal edge in `lib/tenders/state-machine.ts`:

- `createTender` — admin + staff happy paths, company-role refusal,
  unauthenticated refusal, Zod refusal on missing title, force-draft
  even when caller sends a different status.
- `publishTender` — admin happy + audit verb `tender_published`,
  staff happy, company-role refusal, idempotency on already-published,
  closed → published documented as legal (state machine allows it via
  the Day-5 reversal path; this test pins that publishTender naturally
  uses the same gate).
- `closeTender` — happy, idempotency on already-closed, company-role
  refusal.
- `markAwarded` — closed → awarded happy, draft → awarded refusal,
  full close-then-award pipeline (staff role).
- `unpublishTender` — happy when no applications exist; refusal when
  even one application sits on the tender (the count-then-block guard
  in `transitionTenderStatus`).
- `reopenTender` (Day-5) — admin closed → published with
  `tender_reopened` audit + `metadata.reason`, staff refusal
  (admin-only), refusal on non-closed source, optional reason.
- `retractAward` (Day-5) — admin awarded → closed with
  `tender_award_retracted` audit + `metadata.reason`, staff refusal,
  missing-reason refusal (Zod surfaces `field: "reason"`),
  refusal on non-awarded source.
- `deleteTender` — draft happy path (admin), non-draft refusal, staff
  refusal (admin-only), company-role refusal.
- End-to-end pipeline test: create → publish → close → award → retract.
- `applyToTender` × tender status intersection: refused on draft,
  closed, awarded.

**`eligibility.test.ts` (20 tests).** `applyToTender` gate matrix —
each gate exercised in isolation by setting up a tender that fails
ONLY that gate:

- Happy: eligible applicant + writes `tender_applied` audit; tender
  with no eligibility filters admits any signed-in company.
- Sector mismatch → refused with sector name in error.
- Geography mismatch → refused.
- MSME-only + non-MSME applicant → refused; MSME applicant passes.
- Turnover floor (Day 8): below-minimum refused with formatted
  Indian-locale rupee figure in the error, NULL `annualTurnover`
  refused with `field: "annualTurnover"` hint, exactly-meets +
  above-minimum admitted, NULL minimum skips the gate even for
  NULL-turnover applicants.
- Closing date: past refused, future + NULL admitted.
- Status gate: draft / closed / awarded all refused.
- Duplicate-application guard: second submission refused with
  "already applied" copy (the soft check fires before the composite
  unique index would).
- Auth: unauthenticated refused; admin-role refused (company-only).

**`application-actions.test.ts` (21 tests).** The four
application-side actions:

- `withdrawApplication` — own submitted happy with `decidedAt` stamp,
  cross-company refusal (returns "not found" rather than "forbidden"
  to avoid leaking existence), refusal on already-withdrawn,
  refusal on non-submitted (e.g. shortlisted), unauthenticated.
- `updateApplicationStatus` — staff shortlists + rejects (including
  `internalNotes`), company-role refusal, refusal on withdrawn
  (company-driven reversal path), idempotency on no-op status.
- `reinstateApplication` (Day-5) — shortlisted → submitted clears
  `decidedAt` + writes `application_reinstated` audit with
  `metadata.tenderId` and `metadata.reason`; rejected → submitted;
  refusal on withdrawn (recall is the company-driven path); refusal
  on already-submitted; company-role refusal.
- `recallApplication` (Day-5) — within-window withdrawn → submitted
  clears `decidedAt` + writes `application_recalled` audit with
  `previousDecidedAt`, `recallWindowDays=7`, optional `reason`;
  >7 days refused; cross-company "not found"; non-withdrawn refused;
  parent-tender-no-longer-accepting refused; admin role refused
  (company-only).

All three files mock `@/lib/auth/session::readSession` via `vi.mock`
so each test can drive the role-gate paths deterministically. The
real `db` + real `recordAuditEvent` are used so the audit trail is
exercised end-to-end — the assertions on `auditLog` rows would catch
a future refactor that silently dropped the write.

Test totals: 172 → 248 (+76, across +3 files).

### Chunk 3 — Email env scaffolding + Resend deployment doc (commit `d1056db`)

`wrangler.jsonc`:

- Top-level `vars` block gains `EMAIL_FROM` (defaulted to the
  unroutable `noreply@consultway.local` so a misconfigured preview
  can't accidentally send from a real-looking domain) and
  `EMAIL_REPLY_TO` (empty string default; `lib/email/client.ts`
  treats empty as "no reply-to override").
- `env.staging.vars` gains a staging-shaped sender pointing at
  `staging.ops.consultway.info` with a real reply-to.
- `env.production.vars` gains the production sender pointing at
  `ops.consultway.info`.
- Inline comments flag `RESEND_API_KEY` as a `wrangler secret`, NOT
  a vars entry.
- The `triggers.crons` block gets a comment pointing at this report's
  followup (the OpenNext re-export step).

`docs/09-deployment.md` gains a new § 3.5 "Resend Setup":

- One-time domain verification: add the sender domain in Resend,
  paste the SPF + DKIM records into Cloudflare DNS, hit Verify, wait
  for both records to go green.
- Per-environment config: `EMAIL_FROM` + `EMAIL_REPLY_TO` are vars
  (already populated); `RESEND_API_KEY` is set per-env via
  `wrangler secret put`.
- Fallback behaviour: explicit documentation of the log-fallback path
  `lib/email/client.ts` already implements when the key is unset —
  staging deploys stay inert until verification is signed off, and
  the dedup row gets written on stub-log so a mid-day key flip can't
  double-send.
- Post-rollout verification: how to trigger the cron manually via
  `wrangler cron trigger` and check the Resend dashboard for delivery.

No code changes to `lib/email/client.ts` — the dual-path was already
landed correctly at Day 10 and `lib/env.ts` already validated both
`EMAIL_FROM` and `EMAIL_REPLY_TO` (the latter as `optional()`).
`.env.example` already had `RESEND_API_KEY` / `EMAIL_FROM` /
`EMAIL_REPLY_TO` stubs (and editing `.env.example` wasn't authorized
this session anyway).

## Key decisions

**Scheduled handler swallows top-level errors instead of throwing.**
Cloudflare's scheduled handler treats a thrown error as a failed
invocation that surfaces in the dashboard and (with notification
config) can page on-call. Our underlying handlers already structure
their results (`ExpirySweepResult` / `PendingCleanupResult`) and log
per-row errors via the structured logger — a top-level throw would
double-count as both a per-row error AND a worker failure. Swallow
preserves the forensic trail without the page.

**Scheduled handler imports `@/lib/db` directly (Node SQLite) for
now.** Production on Cloudflare Workers will need a D1-backed Drizzle
client, not better-sqlite3. The handler mirrors `scripts/cron-*.ts`'s
construction exactly because the brief asked for parity. When the
OpenNext wiring lands (and a D1 client factory ships alongside it),
the dep injection point in the handler stays the same — only the
`db` import flips to the runtime-aware factory. The handler module
itself stays unchanged.

**OpenNext config deferred over fabricating one.** The brief
explicitly said "stop and flag — don't guess" if the OpenNext
contract gets fiddly. `@opennextjs/cloudflare` isn't installed and
this session was barred from adding deps; writing an
`open-next.config.ts` that imports a non-existent package would fail
tsc and any future build would still need the dep first. The handler
module is the load-bearing piece; the re-export step is one line of
config plus the dep install, both deferred to the deployment session.

**Dispatch by cron string, not by handler name.** The alternative was
`scheduled({ handler: "expiry-sweep" })` with a custom config field.
But Cloudflare's `ScheduledEvent` ships `cron` already, and the
`wrangler.jsonc` is the source of truth for what strings the platform
will fire. Dispatching on `cron` keeps the two in lockstep — adding
a new schedule means editing the wrangler triggers AND the dispatch
table in one PR, and a mismatch surfaces as a "warn + no-op" log line
rather than a silent miss.

**Tests assert role-gated refusals at the action layer, not just
the schema layer.** The schemas accept any well-typed input; the role
gate (`requireAdminOrStaff` / `requireAdmin` / `requireCompanyRole`)
is the actual access boundary. Mocking `readSession` lets each test
flip the caller role around a single action call — equivalent
coverage to running the action three times with three real sessions,
no real cookie machinery needed. Same pattern the documents tests
established at Day 9.

**Eligibility tests exercise one gate per test, not "stack many gates
in one fixture and assert the first failure".** A failing test that
says "sector mismatch" gives an immediate diff; a stacked-gates test
that says "applyToTender refused" hides which gate broke. The 20
eligibility tests are slightly more verbose than a clever-fixture
approach but every assertion now reads as a single sentence.

**Email vars in `wrangler.jsonc`, key still a secret.** Splitting
the sender identity (`EMAIL_FROM` / `EMAIL_REPLY_TO`) from the
credential (`RESEND_API_KEY`) lets code review catch a "we're
sending from the wrong domain in prod" mistake in PRs (the var is in
the diff), while the key never appears in any repo file. Matches the
established pattern for R2 (`R2_BUCKET_NAME` is a var, the access
keys are secrets).

## Gotchas surfaced

**`createTender`'s cached `cachedConsultwayPublisherId` is module-
scoped — survives across tests inside the same worker.** Initially
considered seeding a sentinel "Consultway Infotech" company in the
fixture and letting `createTender` resolve it. That would have worked
for the first test but broken on subsequent tests where the resolver
hits the cache and returns an id that was deleted by the previous
`afterEach`. Fix: pass `publisherCompanyId` explicitly to every
`createTender` call in tests, bypassing the resolver entirely.
Production isn't affected — the resolver caches the real sentinel id
which lives forever.

**Vitest's `mockReset` empties return values too.** Initially had
`mockedReadSession.mockReset()` in `beforeEach` followed by per-test
`mockResolvedValue(...)`. That works, but in tests that never
explicitly logged in (e.g. "refuses unauthenticated callers") the
mock returns `undefined` rather than `null`. The actions check for
falsy session, so `undefined` works the same — kept the pattern for
clarity, but flagged in case a future refactor switches the check to
`if (session === null)` rather than `if (!session)`.

**State machine considers `closed → published` legal.** Documented
in the Day-5 reversals — publishTender doesn't emit the
`tender_reopened` verb, so calling publishTender on a closed tender
would technically succeed but lose the reversal audit trail.
`reopenTender` is the right path; UI never offers publishTender on
closed. The test for "publishing a closed tender" pins this behavior
explicitly so a future tightening of the state machine surfaces here
first.

**`turnover gate` error message surfaces a fixed Indian-locale
format string.** Tests assert `result.error` matches `/10,00,00,000/`
(₹10 crore formatted via `Intl.NumberFormat("en-IN")`). The
formatter's output is locale-stable on Node 20+ but a future Intl
upgrade or runtime swap could change the grouping char. Worth
documenting; not worth tightening to a regex that ignores grouping
because the customer-visible copy IS the grouped form.

**`pnpm cron:expiry-sweep` reports `remindersSkippedDeduped=1`
on first invocation today, not zero.** Confused me for a beat —
expected zero on a fresh run. Day 12 inserted a dedup row for Acme
Mumbai trade license at slot T-30 yesterday, and the row's still
in scope for today's window. The dedup is working correctly; this
will keep being the case until that license either expires (flip
path) or rolls past day-30 from now (out of window).

**OpenNext + Workers runtime swap is bigger than "one dep install".**
The scheduled handler imports `@/lib/db` which transitively imports
`better-sqlite3` — a Node-only native module that fails to load in
the Workers runtime. Production wiring needs a D1-backed Drizzle
client (the existing scaffolding in `lib/db/index.ts` hints at this:
the Node SQLite path is module-scoped with `globalThis.__sqlite`).
That's the deployment session's first task once the dep lands.

## Surfaces touched

```
# Chunk 1 — Scheduled handler + second trigger (commit fcce37e)
lib/crons/scheduled-handler.ts                                      (new)
wrangler.jsonc                                                      (modified - triggers.crons + comment)

# Chunk 2 — Tender test coverage (commit 5b87b4d)
lib/tenders/__tests__/state-machine.test.ts                         (new - 35 tests)
lib/tenders/__tests__/eligibility.test.ts                           (new - 20 tests)
lib/tenders/__tests__/application-actions.test.ts                   (new - 21 tests)

# Chunk 3 — Email env scaffolding + Resend doc (commit d1056db)
wrangler.jsonc                                                      (modified - vars + per-env overrides + comments)
docs/09-deployment.md                                               (modified - new § 3.5 Resend Setup)

# Day 13 report (this commit)
docs/reports/day-13-report.md                                       (new)
```

## Test totals

Before this session: **172 tests across 7 files**, all green (Day 12
end state).

After this session: **248 tests across 10 files**, all green every
run. Net: +76.

Breakdown of the delta — all in
`lib/tenders/__tests__/`:

- +35: `state-machine.test.ts` (lifecycle transitions + create + delete +
  end-to-end pipeline + applyToTender×status intersection).
- +20: `eligibility.test.ts` (the six gates of `applyToTender` × happy
  paths + auth + duplicate guard).
- +21: `application-actions.test.ts` (withdraw + updateStatus +
  reinstate + recall, including the Day-5 reversal audit verbs).

The brief budgeted +30 to +45 tests; we landed at +76. The over-run
is real coverage, not padding — each gate of `applyToTender` got its
own test rather than a clever-fixture combination, and the Day-5
reversal audit verbs each got their own assertion. The unit-of-failure
becomes a single sentence instead of "applyToTender returned the
wrong error somewhere."

No new tests for Chunks 1 or 3 — Chunk 1's scheduled handler is a
thin dispatch wrapper (the underlying handlers already have their own
tests in `lib/documents/__tests__/`), and Chunk 3 is purely env +
doc changes with no code path.

## Followups for Day 14+

**Deployment wiring (carry-forward, partially closed):**

1. **`@opennextjs/cloudflare` install + `open-next.config.ts`.** The
   scheduled handler module exists; the OpenNext config that
   re-exports `scheduled` from it is the remaining glue. Once the
   dep lands, a one-line config file (or augmenting the generated
   worker entry) wires the platform up. This is the right work for
   the deployment session.
2. **D1-backed Drizzle client factory.** `lib/db/index.ts` currently
   opens better-sqlite3 against a file. The Workers runtime can't
   import better-sqlite3 at all. A `getDb(env)` factory that returns
   either a D1-Drizzle client (Workers runtime) or the existing
   better-sqlite3 one (local scripts + tests) is the bridge. Touch
   point: `scheduled-handler.ts`, the document/tender action modules
   (which import `db` directly), and the local cron scripts (still
   want the Node path locally).
3. **Resend domain verification + production secret.** § 3.5 of the
   deployment doc has the full procedure. Lands in the deployment
   session.
4. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
   The current values are `REPLACE_WITH_*` placeholders, intentional.

**Cleanup / nice-to-have:**

5. **Side-sheet vs side-by-side detail view at desktop widths**
   (Day 11 followup, deferred again — UX design call, not load-
   bearing). Carry-forward.
6. **Seed self-healing on changed fixtures** (Day 11 followup) —
   marginal cost-benefit at Phase 1's seed size; `pnpm db:reset`
   exists as the heavier hammer. Carry-forward.
7. **Stage real fixtures into R2** so demo downloads actually
   return bytes rather than R2 404s. Decoupled from cron / email
   work. Carry-forward.
8. **Drift-prone `__drizzle_migrations` tracker** — "always use
   `pnpm db:migrate` (not `db:push`)" needs a one-line note in the
   contributing doc. Trivial; would have been folded into this
   session if I'd noticed earlier.
9. **`listTenders` company-role visibility post-filter is
   approximate.** Documented as tech debt in `lib/tenders/actions.ts`
   already — the total may be off by the number of other-publisher
   drafts on the current page. Long-term fix is a proper SQL OR
   clause. Not load-bearing at Phase 1 scale (<100 tenders) but
   worth a Day-N pass once the row count climbs.
10. **`process.env.NODE_ENV` cast in `vitest.setup.ts`** — minor
    @types/node ergonomic, no behavioural impact.

**Already-resolved this session:**

- Day 12 followup #1 (wrangler cron config + scheduled() entry) —
  partially done as Chunk 1. The handler module + second trigger
  landed; the OpenNext re-export is the remaining ~one line, gated
  on dep install.
- Day 12 followup #2 (Resend domain verification + EMAIL_FROM) —
  the env scaffolding + deployment doc landed as Chunk 3. The actual
  DNS edit + `wrangler secret put` happen in the deployment session.
- The "no tender tests" gap from the Day 12 survey — done as Chunk 2.

## Carry-forward to Day 14

- **`dev` ended at 4 commits past Day 12's final state** (
  `927c81f` was Day 12's report commit; this session's commits are
  `fcce37e` / `5b87b4d` / `d1056db` plus this report's commit).
  Run `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing requires explicit approval per `<permissions>`.
- **248 tests passing on every run.** Three new files, no flakes
  observed across the session's test runs.
- **`pnpm cron:expiry-sweep`** still reports `remindersSkippedDeduped=1`
  while the Day-12 dedup row remains in scope. Expected; not a
  regression.
- **`RESEND_API_KEY` still empty** in `.env.local` — email stays in
  log-fallback. The Resend setup section in the deployment doc is
  the procedure for flipping to real sends.
- **OpenNext + D1 client factory** is the deployment session's
  load-bearing first task. The scheduled handler module is wired
  for the dependency injection that swap requires.
- **`PASSWORD_PEPPER=dev-only-pepper-replace-in-prod`** still in
  `.env.local`. Do NOT change without re-seeding.
- **Phase 2 (Tenders + Notifications) test coverage is now live.**
  Tender mutations have backing assertions; the next set of changes
  on this surface lands with a clearer safety net than Day 12 had.

That's Day 13.
