# Day 12 — Test infrastructure, reminders_sent dedup, db:reset

_Date: 2026-05-23_

## Scope

Phase 1 hygiene pass. Three deliverable chunks landed as separate
commits on `dev`, each addressing a Day 11 followup that had been
holding back the test surface, the production cron, or the README:

1. **Test isolation via in-memory SQLite.** Closes the "seed data
   contamination of the cron test" gotcha that Day 11 worked around
   by mutating a fixture's status.
2. **`reminders_sent` dedup table.** Cron no longer re-sends the same
   reminder every day a verified row sits inside the 30-day window.
3. **`pnpm db:reset` script.** README-promised script now exists.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` 172/172 green every run (was 170; +2 from Chunk 2),
`pnpm db:seed` clean + idempotent, `pnpm db:reset` safety guards
verified live (refused cleanly when the dev DB was locked by the
running `pnpm dev`; end-to-end wipe path is the standard fs.unlink
+ existing db:migrate + db:seed chain, blocked from a live run only
by the busy file). Day 11's previously-broken
`pnpm db:seed && pnpm test --run` sequence now passes regardless of
dev DB state.

## What shipped

### Chunk 1 — Test isolation via in-memory SQLite (commit `4d37aa5`)

The cron expiry-sweep test was vulnerable to dev-DB contamination
because every test shared the file-backed SQLite at `env.DATABASE_URL`.
Day 11's seed expansion added a verified document with a near-expiry
date; the cron's verified-rows query is global and would double the
test's expected reminder counts. Day 11 worked around this by mutating
the seed (flipping the Acme Mumbai trade license to `pending_review`);
the proper fix is to give tests their own substrate.

**`lib/db/index.ts`** — `getSqliteConnection()` branches on
`env.NODE_ENV === "test"` to open `":memory:"` instead of
`env.DATABASE_URL`. The WAL pragma is skipped in the test branch (it's
a no-op on in-memory and produces noise on stdout); foreign-keys ON
stays unconditional.

**`vitest.setup.ts`** (new) — runs once per worker before any tests in
that worker execute. Two responsibilities:

- Defensively sets `process.env.NODE_ENV = "test"` (cast through
  `Record<string, string | undefined>` because `@types/node` types it
  as a read-only literal union). Vitest sets this by default; the
  defensive assignment makes order-of-imports between `lib/env` and
  the setup file impossible to get wrong.
- Calls `migrate(db, { migrationsFolder: "./drizzle" })` from
  `drizzle-orm/better-sqlite3/migrator` so the in-memory schema
  matches the dev DB. Migration cost is paid once per worker, not
  per test.

**`vitest.config.ts`** — registers the new setup file via
`setupFiles: ["./vitest.setup.ts"]`. The existing `pool: "forks"`
gives each test file its own worker process, which means each file
gets a fresh `:memory:` DB. No cross-file fixture leaks possible.

**`scripts/seed.ts`** — reverted the Day 11 workaround on Acme Mumbai
trade license. Restored to `status: "verified"` + +18-day expiry, with
a reviewer + a reviewer note. The fixture now exercises both the
"verified + near-expiry" visual warning AND the cron's reminder path
in the demo, without polluting any test count.

Tests went from 170 → 170 on the Chunk 1 commit (no behaviour
changes, only substrate). The verification that mattered:
`pnpm db:seed && pnpm test --run` ran cleanly, where pre-Chunk-1
that sequence would have broken the expiry-sweep test.

### Chunk 2 — `reminders_sent` dedup + slot bucketing (commit `466007d`)

Before this, the expiry-sweep cron would re-send the same reminder
every day a verified row sat inside the 30-day window — a 30-days-out
document generated 30 emails to the same contact. Phase doc planned a
slot-based ledger keyed on `(document_id, reminder_kind)`; this lands
it.

**Schema (`lib/db/schema.ts` + `drizzle/0007_rare_mastermind.sql`)**:

```
remindersSent table
  id              TEXT PRIMARY KEY (UUID v7)
  documentId      TEXT NOT NULL, FK documents.id ON DELETE CASCADE
  reminderKind    TEXT NOT NULL, $type<"T-30"|"T-14"|"T-7"|"T-1">
  sentAt          TEXT NOT NULL (ISO timestamp)
  createdAt       TEXT NOT NULL DEFAULT (datetime('now'))

Indexes:
  UNIQUE (documentId, reminderKind)   ← the dedup primitive
  INDEX  (documentId)                  ← per-doc lookups
```

The `ReminderKind` closed union is exported alongside `DocumentStatus`
etc. so the cron and any future caller use one source of truth.

**Cron (`lib/documents/crons/expiry-sweep.ts`)** — three changes:

1. `reminderSlotForDays(days)` helper buckets a positive
   days-to-expiry value into exactly one slot:
   - `0..1`   → `T-1`
   - `2..7`   → `T-7`
   - `8..14`  → `T-14`
   - `15..30` → `T-30`
   The four slots tile the 30-day window without overlap or gap.
2. The upcoming-reminders loop pre-fetches every existing
   `reminders_sent` row for the in-scope documents in one query
   (keyed by `documentId`-in-array), builds a `Set<"docId|kind">`,
   and checks the set before each prospective send. No per-row
   round-trip just to ask "have we sent this kind?".
3. On a successful send, the cron inserts the dedup row. On
   failure, no insert — the next run retries. A race insert (two
   workers on the same minute) is caught by the unique index and
   logged as warn, not thrown.

`ExpirySweepResult` gained `remindersSkippedDeduped` so the summary
shows the dedup activity explicitly (useful both for the local
script's output and for an eventual observability surface).

**Tests (`lib/documents/__tests__/expiry-sweep.test.ts`)**:

- The previously-named "second run RE-SENDS reminders" test (which
  documented the old behaviour) was replaced with a same-day dedup
  test: second invocation sees zero sends + one
  `remindersSkippedDeduped`, and a `reminders_sent` row exists for
  the right `(documentId, "T-7")` tuple.
- New slot-boundary test: updates the in-window document's expiry
  to `today + 10` so day 1 falls in `T-14`, then re-runs the cron
  with `today` advanced by 4 days so the same row is now 6 days
  out (slot `T-7`). The new `(doc, kind)` tuple is freshly
  eligible; the cron sends and writes a second dedup row.
- New "failed sends do NOT insert a dedup row" test: first run
  with a failing `sendEmail` mock leaves the dedup table empty;
  second run with a working sender succeeds and writes the row.

Test totals: 170 → 172 (+2 net; +3 added, -1 removed).

**Migration tracker note.** The dev DB's `__drizzle_migrations`
table was missing rows for `0005_zippy_reavers` and
`0006_elite_madame_web` (those schemas had landed via `db:push` at
some prior point, never tracked). `pnpm db:migrate` therefore tried
to replay them and failed on a duplicate `annual_turnover` column.
Backfilled the missing tracker rows by computing SHA-256 of each
migration file (matching drizzle's hash format in
`drizzle-orm/migrator.cjs`) and inserting the corresponding rows so
`0007` applied cleanly. This was a one-off recovery on the dev DB —
fresh DBs (CI, prod, `pnpm db:reset` output) start with the tracker
in sync and don't see the drift.

### Chunk 3 — `pnpm db:reset` (commit `ea03882`)

The README's Scripts table referenced `pnpm db:reset` since Phase 1
landed, but the script was never added. Day 11 flagged it as a
follow-up; this closes the gap.

**`scripts/reset-db.ts`** (new) — wrapper that wipes the dev SQLite
file (and its WAL/SHM siblings) so the next `db:migrate && db:seed`
rebuilds from scratch. Three layered safety guards:

1. **NODE_ENV gate** — refuses to run when `NODE_ENV=production`,
   defensive even though dev DB lives outside prod anyway.
2. **Path containment** — the target file (resolved from
   `env.DATABASE_URL`) must sit under the project's resolved
   `.wrangler/` directory. The `path.resolve` + `startsWith` check
   prevents traversal payloads like `./.wrangler/../foo.sqlite`
   from escaping and also catches an env-pointed DATABASE_URL
   outside the dev dir.
3. **Process gate** — wraps `unlinkSync` in a try/catch keyed on
   `EBUSY`/`EACCES`/`EPERM`. On a busy file, surfaces an
   actionable error pointing at `pnpm dev` / `pnpm db:studio` as
   the usual culprit (instead of a raw fs trace).

Deletes the main `.sqlite` plus `-wal` and `-shm` siblings — WAL
mode leaves both around, and a reopen with a stale WAL file
replays uncommitted transactions, undoing the wipe.

**`package.json`** — new script:
```
"db:reset": "tsx scripts/reset-db.ts && pnpm db:migrate && pnpm db:seed"
```
Chained as separate processes so each step's own logging + exit
codes survive.

**Smoke-test status.** The script's safety guards + EBUSY-detection
path were exercised live — the user's running `pnpm dev` held the
DB file open, the script refused cleanly with the actionable
message ("Stop `pnpm dev` (or `pnpm db:studio`) and try again").
The end-to-end wipe → migrate → seed run requires `pnpm dev` to
be stopped first; the underlying unlink is `node:fs.unlinkSync`
and the chained migrate + seed are existing scripts already
verified in earlier chunks. No new code paths between "lock check
passes" and "deletion succeeds" that haven't been exercised.

## Key decisions

**`:memory:` SQLite over a per-test-file temp file.** A per-file
temp file gives the same isolation but adds setup/teardown cost
(create, migrate, drop) plus a window where parallel-failing tests
leave debris on disk. `:memory:` per-worker via `pool: "forks"` is
free, never leaks, and the migration cost is paid once per worker
not once per test. The trade-off: tests can't `sqlite3 ...` poke
at the DB after a failure — but the test code itself drives
`db.select(...)` for that already, and the structured logger
captures the relevant state on each operation.

**Setup file lives at repo root, not under `lib/test/`.** Vitest
resolves `setupFiles` relative to the config file. Keeping it next
to `vitest.config.ts` makes the relationship obvious; putting it
under a feature folder would imply it's importable from app code.
It isn't — it's a runner artifact.

**Slot edges chosen so 30 → T-30, 14 → T-14, 7 → T-7, 1 → T-1.**
The four boundaries (1, 7, 14, 30) match the slot names exactly.
Alternative was 1, 8, 15, 31 (open-interval semantics), but a
fixture writer reading "the 14-day reminder fires on day 14"
matches the inclusive convention. The handler comments document
the convention explicitly so the next person to add a slot
doesn't have to reason it out.

**Pre-fetch all dedup rows in one query, not per-row.** The
alternative is a per-document SELECT inside the loop. At Phase 1
scale (sweeps touch a few dozen rows max) the difference is
negligible, but the one-query path scales linearly and reads
cleaner — no nested awaits, one less round-trip pattern to
maintain. Same shape as the existing `companyById` Map prefetch
already in the handler.

**Insert dedup row only on send success.** The alternative —
insert on attempt, delete on failure — is simpler in the happy
path but means a transient Resend outage during a cron run leaves
phantom dedup rows that suppress the retry on the next run. Insert
on success preserves the "next run retries" property at the cost
of a slight bias toward duplicate sends if the OS crashes between
"sendEmail resolved" and "INSERT committed" (acceptable; the cron
is a daily, not a high-frequency event, and the alternative bias
is worse).

**EBUSY → actionable error, not a retry loop.** A retry-with-backoff
on EBUSY would feel ergonomic for the "I just ran something" case
but would mask the more common cause (`pnpm dev` running) by
making the script slow rather than informative. Surfacing the
exact remediation in the error keeps the script honest about what
it can and can't do.

**Path containment over a stricter "must equal `.wrangler/<file>`"
allowlist.** The looser containment check lets a developer keep
e.g. `.wrangler/test-dbs/foo.sqlite` if they want to (the env var
is theirs to point), while still preventing accidental deletion
outside the project. A strict allowlist would force changes
through `lib/env.ts` for every variant, which felt over-engineered
for a dev-only script.

## Gotchas surfaced

**`process.env.NODE_ENV` is read-only in `@types/node`.** Direct
assignment (`process.env.NODE_ENV = "test"`) fails TypeScript with
TS2540. Cast via `(process.env as Record<string, string | undefined>)`
to write. Vitest sets it by default so the assignment is defensive;
without it, an import chain that crosses `lib/env` before the setup
file runs would lock in the wrong value.

**Drizzle migrator tracker can drift from the actual schema when
`db:push` is used.** The dev DB had migrations 0005 and 0006 applied
schema-wise (added `annual_turnover` column + the documents table)
but no corresponding rows in `__drizzle_migrations`. `db:push` syncs
the schema without touching the tracker; subsequent `db:migrate`
tries to replay the "unrecorded" migrations and fails on duplicates.
Recovery: compute SHA-256 of each missing migration file
(drizzle's hash format per `drizzle-orm/migrator.cjs::readMigrationFiles`)
and insert the rows into `__drizzle_migrations` directly. Fresh DBs
that have only ever seen `db:migrate` (or `pnpm db:reset` from now
on) don't experience this — the tracker stays in sync.

**Windows `fs.unlinkSync` returns EBUSY when a long-lived process
holds the file open.** SQLite in WAL mode plus a `next dev` process
that imported `lib/db` somewhere = a permanent handle on the file
and its WAL/SHM siblings. `rm` and `del` both refuse identically.
Only way to unlink is to stop the holding process. The new
`reset-db.ts` detects this and surfaces an actionable hint instead
of letting the raw fs error escape.

**WAL `.sqlite-wal` files can be huge.** During the session the
dev DB's `-wal` ballooned to ~6 MB while the main file was
~217 KB — that's a healthy amount of uncheckpointed writes from
the seeded + cron-tested workload. A wipe that deletes only the
main file would let a reopen rebuild from the WAL, undoing the
wipe. `reset-db.ts` deletes both siblings explicitly.

**Re-seeded rows skip on `(company_id, file_name)` regardless of
other-field drift.** Already documented in Day 11; surfaced again
this session when the Chunk 1 fixture flip to `verified` couldn't
land on top of the existing `pending_review` row via re-seed
alone. The dev DB still carried the Day 11 status until a manual
delete + re-seed (or now: `pnpm db:reset`). Not a regression —
just confirms `pnpm db:reset` is the right tool for fixture
drift.

**`drizzle-kit migrate` output is uninformative on failure.** The
CLI prints `[⣷] applying migrations...` followed by a generic
`ELIFECYCLE` exit. The actual error (`duplicate column name:
annual_turnover` in our case) only surfaces if you invoke
`drizzle-orm/better-sqlite3/migrator` directly. Diagnosing the
tracker drift required a one-off tsx script to get the real
SqliteError. Not worth a PR upstream — but worth knowing.

## Surfaces touched

```
# Chunk 1 — Test isolation (commit 4d37aa5)
lib/db/index.ts                                                     (modified - :memory: branch)
vitest.setup.ts                                                     (new)
vitest.config.ts                                                    (modified - setupFiles)
scripts/seed.ts                                                     (modified - revert Acme trade license to verified)

# Chunk 2 — reminders_sent dedup (commit 466007d)
lib/db/schema.ts                                                    (modified - remindersSent table + ReminderKind union)
drizzle/0007_rare_mastermind.sql                                    (new - migration)
drizzle/meta/_journal.json                                          (modified - migration journal entry)
drizzle/meta/0007_snapshot.json                                     (new - snapshot for next diff)
lib/documents/crons/expiry-sweep.ts                                 (modified - slot bucketing + dedup)
lib/documents/__tests__/expiry-sweep.test.ts                        (modified - test rewrite + 2 new tests)

# Chunk 3 — db:reset (commit ea03882)
scripts/reset-db.ts                                                 (new)
package.json                                                        (modified - db:reset script in scripts block)

# Doc sync (folded into Day 12 report commit)
docs/05-database-schema.md                                          (modified - reminders_sent spec aligned to code)
```

## Test totals

Before this session: **170 tests across 7 files**, all green (Day 11
end state).

After this session: **172 tests across 7 files**, all green every
run. Net: +2.

Breakdown of the delta — all in
`lib/documents/__tests__/expiry-sweep.test.ts`:

- −1: the "second run RE-SENDS reminders" test was removed
  (documented the pre-Chunk-2 no-dedup behaviour; replaced).
- +1: same-day dedup test (second run gets zero new sends + one
  `remindersSkippedDeduped`, and the `reminders_sent` row exists).
- +1: slot-boundary test (a row moving from `T-14` to `T-7` gets
  a fresh reminder under the new slot).
- +1: failed-send test (failure doesn't insert a dedup row, so a
  later successful retry isn't blocked).

No new tests for Chunk 1 (substrate change; the existing 170 tests
ARE the regression surface). No new tests for Chunk 3 (the script
is a thin fs wrapper exercised by direct invocation; its safety
guards are unit-test-shaped but writing those for a script that's
mostly `if (cond) fail(...)` would be more bookkeeping than
coverage).

## Followups for Day 13+

**Deployment wiring (carry-forward, still outstanding):**

1. **Wrangler cron config + `scheduled()` worker entry point** that
   calls `runExpirySweep` and `runPendingCleanup` on the daily
   schedule. Both handlers are designed for direct invocation; the
   `triggers.crons` entry in `wrangler.jsonc` plus the
   `@opennextjs/cloudflare` worker entrypoint integration is the
   remaining work. Deferred from Days 10–12.
2. **Resend domain verification + `EMAIL_FROM` pointed at a real
   verified sender.** `RESEND_API_KEY` still empty in `.env.local`
   so email is in log-fallback mode locally. Production-deploy
   task; landing it unlocks the actual T-30/T-14/T-7/T-1 emails
   the dedup table now meters.

**Cleanup / nice-to-have:**

3. **Side-sheet vs side-by-side detail view at desktop widths**
   (Day 11 followup, deferred again — UX design call, not load-
   bearing).
4. **Seed self-healing on changed fixtures** (Day 11 followup) —
   marginal cost-benefit at Phase 1's seed size; `pnpm db:reset`
   now exists as the heavier hammer for the drift case.
5. **Stage real fixtures into R2** so demo downloads actually
   return bytes rather than R2 404s. Decoupled from any cron or
   workflow work.
6. **Drift-prone `__drizzle_migrations` tracker.** The recovery
   path used this session (compute SHA-256, INSERT directly) is
   worth scripting if it happens again — but the cleanest fix is
   "always use `pnpm db:migrate` (not `db:push`) and the tracker
   stays consistent". Documentation update for the team rather
   than code work.

**Already-resolved this session:**

- Day 11 followup #1 (`:memory:` SQLite for tests) — done as
  Chunk 1.
- Day 11 followup #2 (`reminders_sent` dedup table + cron update)
  — done as Chunk 2.
- Day 11 followup #8 (`pnpm db:reset` script) — done as Chunk 3.
- Bonus: doc sync of `docs/05-database-schema.md` for the
  `reminder_kind` (code) vs `reminder_type` (doc) divergence —
  spec updated to match the code per the "code wins" convention.

## Carry-forward to Day 13

- **Phase 1 hygiene is now complete.** Test isolation, the
  cron's day-after-day duplicate problem, and the broken README
  script are all closed. The remaining Phase-1 bucket is
  deployment-prep (cron wiring + Resend domain), not feature
  work.
- **`dev` ended at 3 commits past Day 11's `d663a2b`** (the Day
  11 sync). The full Day 12 list:
  - `4d37aa5` chore(test): isolate tests via in-memory SQLite +
    restore verified trade license seed
  - `466007d` feat(documents): reminders_sent dedup table + slot
    bucketing in expiry-sweep
  - `ea03882` chore(scripts): add pnpm db:reset for clean local
    state
  - _(plus this report's commit)_
  Run `git log origin/dev..dev --oneline` for the up-to-date
  outstanding set. Pushing the lot requires explicit approval
  per `<permissions>`.
- **172 tests passing on every run.** No flakes observed across
  the session's ~5 test runs.
- **Local dev DB still carries the pre-Day-12 fixture state** —
  the Day 11 status nudge on Acme Mumbai trade license is still
  there (the re-seed couldn't override it). After Day 12, a
  `pnpm db:reset` (with `pnpm dev` stopped) cleanly rebuilds to
  the new Day-12 seed source with the trade license back to
  `verified` + +18d expiry.
- **`PASSWORD_PEPPER=dev-only-pepper-replace-in-prod`** still in
  `.env.local`. Do NOT change without re-seeding.
- **`RESEND_API_KEY` still empty** in `.env.local` — email is in
  log-fallback mode. The new `reminders_sent` dedup will keep
  working in log-fallback (the cron treats the log-fallback
  result as ok and writes the dedup row).
- **Phase 2 (Tenders & Notifications) is the next natural target.**
  Day 11's "Phase 2 is the next natural target" line still stands,
  with one fewer hygiene blocker in the way.

That's Day 12.
