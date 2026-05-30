# Day 32 — comprehensive staging fixtures + R2 placeholder uploads

_Date: 2026-05-29 (late session — the UTC clock had already rolled to
2026-05-30 for the operational timestamps below)_

## Scope

Execution day, no pivots. Phase B was locked at the end of Day 31
("comprehensive staging fixtures, medium scale, R2 follow-up queued")
and this session ran it end to end: build the bridge from the local
seed to the remote staging D1, ship the medium-scale dataset, ship the
admin metadata, then upload R2 placeholders so document downloads work.
Closed with auto-commit + push (3 commits) and a green CI + staging
deploy.

The shape was: a small, **unit-tested** dump tool plus two `wrangler
d1 execute --file` ships, verified at the data layer with a full
FK-integrity sweep — followed by a dependency-free placeholder-PDF
generator and ten `wrangler r2 object put`s, verified with a
byte-identical round-trip download.

End-of-day state: `dev` advanced `cd120d9 → 3509ef1` (3 commits);
staging D1 carries 279 fixture rows across 8 entity tables plus the
admin's profile + preferences; staging R2 carries 10 placeholder PDFs;
CI + Deploy Staging green for `3509ef1`; staging health 200.

## What shipped

### Item F — `dump-staging-fixtures` (the local-seed → remote-D1 bridge)

Commit: `da8876b`. The deferred Day-21 #2 ("realistic Indian-flavoured
fixture data") extended for remote D1. `scripts/seed.ts` already
populates everything but explicitly targets local SQLite; this is the
bridge.

- `scripts/dump-staging-fixtures.ts` (NEW) — opens a **scratch** SQLite
  (`.wrangler/seed-dump-source.sqlite`, readonly) and emits
  `scripts/seed-staging-fixtures.sql`: one `INSERT … ON CONFLICT DO
  NOTHING` per row across the 8 entity tables. Column lists are
  discovered via `PRAGMA table_info` (never hard-coded); rows are
  ordered by `id` for deterministic output. A hard **safety rail**
  refuses to run if the source basename is `consultway-local.sqlite`
  (the dev DB), so a fat-fingered `--source` can't read or corrupt dev.
- `scripts/__tests__/dump-staging-fixtures.test.ts` (NEW) — 12 cases on
  the only non-trivial logic: `sqlLiteral` (NULL / int / bigint / bool /
  `Buffer`→`X'…'` / string with doubled `''` / unicode / throw-on-NaN /
  throw-on-object), `quoteIdent`, and `buildInsertStatement`.
- `package.json` — added `dump:staging-fixtures`.
- `scripts/seed-staging-fixtures.sql` (NEW, generated, committed) — the
  exact 279-row dataset that was shipped (audit/reproducibility).

Provisioning the scratch DB never touched the dev DB: `DATABASE_URL`
was set inline on **each** command (`db:migrate`, then `db:seed:medium`)
rather than exported, so a failed `export` could never leak the default
dev path.

### Item G — Comprehensive dataset on staging D1

Applied via `wrangler d1 execute consultway-staging --remote --env
staging --file scripts/seed-staging-fixtures.sql`: **279 queries, 2110
row-writes (data + indexes), success, no FK errors.** Pre-ship gate
confirmed a clean slate first (`companies 0`, only the 2 admin rows).

Per-table: companies 16 · users 17 · tenders 12 · documents 60 ·
tender_applications 34 · projects 12 · transactions 125 · reminders_sent 3.

### Item U — Admin profile + preferences metadata (the Day-31 carry-over)

Applied `scripts/seed-staging-mayuresh-metadata.sql` (drafted Day 31,
shipped today): 2 queries — `UPDATE users` (phone, job_title,
email_verified_at) + upsert `user_preferences` (warm-ambient / compact /
all toggles). Verified live on `mayuresh.dongare@outlook.com`.

### Item R — R2 placeholder uploads (the Day-31 follow-up)

Commit: `3509ef1`. Seeded `documents` reference R2 keys that 404 on
download; this makes the download path real for a representative sample.

- `scripts/make-placeholder-pdf.ts` (NEW) — emits a minimal **valid**
  single-page PDF (620 bytes) with a correct cross-reference table,
  **dependency-free**. No `@react-pdf/renderer` / `pdf-lib` — a
  deliberate echo of the Day-31 finding (workerd forbids runtime WASM;
  `@react-pdf` is out). Pure `buildPlaceholderPdf` export.
- `scripts/__tests__/make-placeholder-pdf.test.ts` (NEW) — 3 cases; the
  load-bearing one parses the emitted xref table and asserts every
  offset lands exactly on its `N 0 obj` header (the silently-breakable
  bit), plus a `/Length`-matches-stream check and char-stripping check.
- Uploaded the placeholder under **10** representative `file_key`s via
  `wrangler r2 object put consultway-docs-staging/<key> --remote` —
  spread across all 5 hand-authored companies (Acme, BuildRight,
  GreenTech, Nimbus, Vertex), all 5 document types, and mixed statuses
  (verified / pending_review / rejected / expired). Verified a
  byte-identical round-trip with `wrangler r2 object get` (`%PDF-1.4`,
  620 bytes, `cmp` identical).

## Key decisions

**Dump ALL seeded users, not "company-side only" — a locked decision the
FK graph forced to change.** The Day-31 plan locked "users: seeded
company-side accounts only, admins skipped." But `documents.uploaded_by`
is **NOT NULL + ON DELETE RESTRICT**, and in the fixtures (and the
generated rows at medium scale, e.g. `admin2@consultway.info`) most
uploaders/reviewers are staff/admin users. Skipping them would dangle
every document's `uploaded_by` and fail the insert under D1's FK
enforcement. Resolution: drop the user filter. This is safe because the
seeded users are **email-disjoint** from the real staging admins
(`@consultway.local` / generated fakes vs. `mayuresh.dongare@outlook.com`),
so there's zero email collision, and `ON CONFLICT DO NOTHING` protects
the real rows regardless. The post-ship 0-orphan sweep proved it landed
referentially sound. Surfaced to Mayuresh before writing the script; he
defaulted to this option (A).

**Emit in FK-dependency order, not the prompt's enumeration order.** The
plan listed `users` before `companies` and `documents` before `tenders`,
which violates `users.company_id → companies` and
`documents.* → users/companies`. The schema comment confirms D1 enforces
FKs, and `wrangler d1 execute --file` applies statements in order, so
the emit order is parent-first: companies → users → tenders → documents
→ tender_applications → projects → transactions → reminders_sent. Correct
whether or not FKs are enforced.

**Target-less `ON CONFLICT DO NOTHING` for idempotency.** Re-applying
the same file conflicts on the primary key of every present row and
skips it. Target-less (no conflict column) also catches natural-key
collisions (email, reference_number, the `(tender_id, company_id)`
unique) if the file is ever regenerated with fresh UUIDs and re-applied.

**Scratch DB isolation + a hard safety rail.** The dump reads a
throwaway `.wrangler/seed-dump-source.sqlite` provisioned just for this,
never the dev DB. The script throws if pointed at `consultway-local.sqlite`.

**Generated SQL is committed.** Regenerating yields new UUIDs (UUID v7,
fresh per seed run) and re-baked relative dates, so the committed
`seed-staging-fixtures.sql` is the canonical record of exactly what is on
staging — not a reproducible-to-the-byte artifact. That's intentional;
the value is the audit trail, not bit-reproducibility.

**One reused placeholder PDF across all 10 R2 keys.** Identical bytes
under different keys fully exercises the download plumbing (presigned
GET, content-type, byte integrity); per-document content would add
nothing to the smoke test.

## Gotchas surfaced

**D1 caps the number of terms in a compound SELECT.** A verification
query with 6 `UNION ALL` branches failed with `too many terms in
compound SELECT: SQLITE_ERROR [code: 7500]`; an 11-branch one would too.
The limit is far below stock SQLite's 500. Fix: express multi-bucket
checks as **scalar-subquery columns** in a single-row SELECT
(`SELECT (SELECT COUNT(*) …) AS a, (SELECT COUNT(*) …) AS b, …`) — no
compound SELECT, no limit. This is the right shape for the FK-orphan
sweep and the per-status breakdowns anyway.

**`documents.uploaded_by` (NOT NULL / RESTRICT) dictates which users a
fixture dump must include.** Any dump that ships documents must ship
their uploader/reviewer users too, or the insert fails under FK
enforcement. Generalises: when sub-setting fixture rows, walk the NOT
NULL FK edges first and include every referenced parent. (This is what
forced the Option-A decision above.)

**TS `target: ES2017` disallows BigInt literals.** `1_000_000_000n` in a
test tripped `TS2737: BigInt literals are not available when targeting
lower than ES2020`. The `BigInt` *global* is fine (the tsconfig `lib`
includes `esnext`); only the `n`-suffix literal is gated by `target`.
Use `BigInt(1_000_000_000)` instead.

**`wrangler r2 object` commands need `--remote` to hit the real bucket**,
same as `d1 execute`. The object path is `<bucket>/<key>` and the key
may contain `/` (our keys are `companies/{uuid}/{uuid}/{file}`); wrangler
parses the first segment as the bucket and the rest as the key.

**`gh` still isn't installed in this Git Bash environment** (carried from
Day 31). Polled the deploy via the GitHub REST API + a one-line `node`
parser instead — the repo's Actions API is publicly readable, so no
token was needed.

## Surfaces touched

This session (committed on `dev`):

```
scripts/dump-staging-fixtures.ts                         (NEW — scratch SQLite → SQL emitter)
scripts/__tests__/dump-staging-fixtures.test.ts          (NEW — 12 escaping/assembly tests)
scripts/make-placeholder-pdf.ts                          (NEW — dependency-free valid-PDF generator)
scripts/__tests__/make-placeholder-pdf.test.ts           (NEW — 3 xref/structure tests)
scripts/seed-staging-fixtures.sql                        (NEW — generated, 279 rows, shipped to staging)
scripts/seed-staging-mayuresh-metadata.sql               (NEW — admin profile + prefs, shipped)
package.json                                             (modified — dump:staging-fixtures script)
docs/reports/day-31-report.md                            (NEW — committed this session, was untracked)
docs/reports/day-32-report.md                            (NEW — this file)
.github/workflows/deploy-staging.yml                     (modified — paths-ignore docs/** + scripts/**)
```

Remote state changed (not in git):

```
D1 consultway-staging   +279 fixture rows (8 tables) + admin profile/prefs
R2 consultway-docs-staging   +10 placeholder PDFs (620 bytes each)
```

Commits: `e7224a5` (docs: Day 31 report) · `da8876b` (feat(seed):
comprehensive staging fixtures) · `3509ef1` (feat(seed): placeholder-PDF
generator). Pushed `cd120d9..3509ef1`.

## Test totals

Before Day 32 on `dev`: **683 passing across 36 files** (Day 31 end).
After Day 32 on `dev`: **697 passing + 1 skipped across 38 files**.

Added 2 test files / +15 tests this session (12 dump-escaping + 3
PDF-structure), all passing. The lone skip is the pre-existing
`lib/preferences/__tests__/server.test.ts` Proxy-incompatible spy case
(Day-30 #5 follow-up), not introduced here.

`pnpm exec tsc --noEmit` clean. CI (`ci.yml`) and Deploy Staging
(`deploy-staging.yml`) both green for `3509ef1` — the deploy runs `tsc`
+ `pnpm test --run` + D1 migrations (none pending) + OpenNext build +
deploy. The changes are scripts/docs/SQL only (nothing bundled into the
worker), so the deploy is a functionally-identical redeploy.

## Live URL + data state

Layer A staging (unchanged URL, advanced to `3509ef1`):
- **URL**: https://consultway-ops-staging.mayuresh-dongare.workers.dev
- **Health**: 200 OK
- **Deploy**: [run 26673677365](https://github.com/allstarmayu/consultway-ops/actions/runs/26673677365) — success

Staging D1 now carries (verified via remote query):
- companies 16 — compliant 10 · pending 2 · expired 1 · suspended 1 ·
  rejected 1 · non_compliant 1 · JV 2 · MSME 3 (all 6 compliance states)
- tenders 12 — draft 2 · published 6 · closed 2 · awarded 2
- projects 12 — planning 2 · active 5 · on_hold 2 · completed 2 · cancelled 1
- tender_applications 34 — submitted 11 · shortlisted 10 · rejected 7 · withdrawn 6
- documents 60 — pending 1 · pending_review 8 · verified 38 · rejected 5 · expired 8
- transactions 125 — invoice ₹18.93cr · payment ₹11.59cr · expense
  ₹10.22cr · advance ₹30.38cr · refund ₹7.11cr (reports KPIs non-zero)
- **FK-integrity sweep: all 12 orphan checks = 0**

Staging R2 (`consultway-docs-staging`): 10 placeholder PDFs uploaded;
download round-trip verified.

## Followups for Day 33+

**Accepted caveats from this session (honest, not bugs):**

1. **50 of 60 documents still 404 on download** — only 10 representative
   R2 placeholders were uploaded. Expand the upload set if a fuller
   download demo is wanted (the generator + the `wrangler r2 object put`
   loop are reusable; just widen the key sample). The 10 cover every
   company/type, so the flow is provably working.

2. **Seeded users can't sign in on staging** — their `password_hash` is
   hashed against the LOCAL pepper. Rows exist for FK + UI population
   only. Your admin login is unaffected. (Not fixable without re-hashing
   against the staging pepper, which the seed can't see.)

**Specifically teed up:**

3. **Authenticated UI click-through as `mayuresh.dongare@outlook.com`** —
   the one verification I couldn't do (signing in needs the password).
   Eyeball `/dashboard/{companies,tenders,projects,reports,transactions}`
   for filters + non-zero KPIs + chart render, and try downloading one of
   the 10 placeholder-backed documents (e.g. Acme's GST cert). Data layer
   is fully proven; this is the visual confirmation.

4. **Stale config cleanup bundle** (touches protected files — needs your
   per-edit OK per CLAUDE.md): drop `serverExternalPackages:
   ["@react-pdf/renderer"]` from `next.config.ts`; remove
   `@react-pdf/renderer` from `package.json` deps (still listed, unused on
   `dev` since the print pivot; the spike branch keeps its own); tombstone
   or delete `docs/DEPLOY_LAYER_A_STATUS.md` (stale — predates Day-30
   Layer A success). ~15 min once approved.

5. **Manual print-preview check** (you, when convenient) — still open
   from Day 31. One-line palette tweak available if borders/muted text
   read too faint on paper.

**Carried forward (unchanged):**

6. G small-wins bundle: cron handler wiring (Day-30 #4) + the skipped
   `lib/preferences` Proxy-spy fix (Day-30 #5) + bundle-size CI step
   (Day-30 #7) + doc rewrite sweep (Day-30 #6, esp. `04-architecture.md`,
   `05-database-schema.md`, `06-api-reference.md`). Independent, ~30-45
   min each.

7. PDF reports via Cloudflare Browser Rendering (Day-31 #5) — when the
   feature re-prioritises. `spike/pdf-react-worker` holds the renderer +
   the WASM finding.

8. In-app user management UI (Day-30 #2) + Resend domain verification
   (Day-30 #3) — pair these. The comprehensive user roster now on staging
   makes the list view demoable.

9. Cmd+K command palette (Day-26 #6), email-change flow (Day-27 #2),
   organizations table (Day-26 #4), 2FA (Day-25 #4), active-sessions list
   (Day-25 #5) — the long tail, unchanged.

## Carry-forward to Day 33

- **Phase B is done.** Comprehensive staging fixtures + admin metadata +
  R2 placeholders are live and verified at the data layer. The
  comprehensive-staging-fixtures epic (Day-21 #2 → Day-31 #1/#2) is
  closed.

- **`scripts/dump-staging-fixtures.ts` + `scripts/make-placeholder-pdf.ts`
  are reusable.** When the seed fixtures change, re-provision the scratch
  DB → `pnpm dump:staging-fixtures` → ship; re-run the R2 loop to refresh
  placeholders. Both are unit-tested.

- **`.wrangler/seed-dump-source.sqlite` is a disposable scratch DB**
  (gitignored). Safe to delete; regenerating is a ~30s migrate+seed.

- **Staging is at `3509ef1`**, health green. GitHub Actions on autopilot
  for every push to `dev`. The staging deploy now **skips docs/scripts-
  only pushes** (`paths-ignore` added to `deploy-staging.yml` this
  session); `ci.yml` still runs tsc + tests + build on every dev push, so
  those changes are still validated — just not redundantly redeployed.

- **CLAUDE.md hard rules still hold** on `next.config.ts` / `package.json`
  deps / `wrangler.jsonc`. The stale-config cleanup bundle (#4) needs an
  explicit OK each time.

An execution day with one genuine decision: the `documents.uploaded_by`
FK forcing the "dump all users" change to a locked plan. Catching it from
the schema *before* writing the dump — rather than from a failed remote
insert — was the high-leverage moment. Everything shipped, everything
verified, deploy green. Phase B closed.
