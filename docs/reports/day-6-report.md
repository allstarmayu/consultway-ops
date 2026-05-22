# Consultway Ops - Day 6 Report

**Date:** May 18, 2026
**Author:** Mayur (with Claude as engineering partner)
**Branch:** `dev`
**Commits:** 4 new commits on top of Day 5's foundation

---

## Executive summary

Day 6 closed two of the longest-standing pieces of debt on the project:
the `audit_log` table (stubbed since Day 2) and the auth gate at the
network boundary (the existing `proxy.ts` was bouncing unauthenticated
requests but the post-login round-trip was unwired). Every mutation
across companies, tenders, and tender applications now persists a real
row to D1 instead of just emitting a log line. A `listAuditEvents`
read API ships ready for Day 7's activity-feed widget to consume.
Sign in, get bounced off `/dashboard/companies`, log in, and you land
back on the page you tried to reach, with an open-redirect guard in
place to keep that round-trip safe.

A fourth, smaller commit also landed: the snapshot tooling that had
been silently dropping files since Day 1 was replaced end-to-end with
a cross-platform TypeScript generator. Two new reference files
(`docs/project-tree.md` and `docs/key-files-snapshot.md`) now drive
project-knowledge context in Claude, with the tree fully derived from
`git ls-files` (cannot drift) and the snapshot driven by a curated
config (`scripts/snapshot-config.ts`).

Four commits shipped to `origin/dev`. Each is independently `tsc`-clean
and independently smoke-tested. Two non-trivial side discoveries
landed alongside the planned work and are written up below: a
corrupted `__drizzle_migrations` bookkeeping table that had been
silently missing a row since Day 3, and the snapshot script's
hand-maintained section list that quietly skipped `proxy.ts` (the
trigger for the tooling rewrite).

---

## What works today

### Persistent audit log

- `audit_log` table on D1 with ten columns: id, actor_id, actor_role,
  action, target_type, target_id, before, after, metadata, created_at
- Four indexes covering the three dominant access patterns: per-entity
  history (`(target_type, target_id)`), per-actor investigation
  (`actor_id`), verb-specific feeds (`action`), and recent-first
  activity feeds (`created_at DESC`)
- JSON columns for before / after / metadata via Drizzle's
  `mode: "json"` - SQLite stores TEXT, the app layer is the source of
  truth for shape
- No FKs on `actor_id` or `target_id`. An audit row must survive the
  deletion of its actor or target - that's the whole point of an audit
  trail. The cost is occasional dangling pointers for forensic queries
  to handle; the benefit is a tamper-resistant ledger.
- Append-only by design. No update or delete actions exist on this
  table. If we ever need GDPR purges or retention windows, that lands
  as its own deliberate `lib/audit/retention.ts` with its own role gate.

### `recordAuditEvent` body swap

- Body now writes a row to `audit_log` alongside the existing
  structured-log emit. Callers don't change - the public API of the
  module has been stable since Day 2 and stayed identical through
  this swap.
- Log line fires BEFORE the DB insert so a total D1 outage still
  leaves a grep-able trail in the Workers log stream.
- Never throws. Insert failures get logged via the structured logger
  and the parent Server Action proceeds normally. The principle from
  Day 2 stands: degraded audit beats failed user action.

### Target-type split for application events

- `AuditTargetType` union gained `tender_application` as a distinct
  value alongside `tender`. Four application-state-change call sites
  (`withdrawApplication`, `updateApplicationStatus`,
  `reinstateApplication`, `recallApplication`) now log against the
  application id directly, with `metadata.tenderId` preserving the
  parent reference.
- `applyToTender` intentionally stays scoped to the tender. The event
  reads as "this tender received a submission" from the audit-trail
  reader's perspective, not as a per-application creation.
- This split is what lets Day 7's per-application history widget be
  a single indexed lookup instead of a metadata-walk.

### `listAuditEvents` read API

- New paginated, filtered read function in `lib/audit/log.ts`. Returns
  newest-first with `limit` (default 50, capped at 200) and `offset`.
- Filters compose with AND: `targetType`, `targetId`, `actorId`,
  `action`. All optional.
- Role-aware visibility scope:
  - admin / staff see every row
  - company-role users see rows where they were the actor, plus rows
    where the target is one of their own applications (resolved via
    a query against `tender_applications.company_id`)
  - unauthenticated callers get `{ ok: false, error }`
- No UI consumer this session. Day 7's dashboard activity-feed widget
  will be the first caller.

### Auth at the network boundary

- `proxy.ts` (Next 16's rename of `middleware.ts`) was already in
  place doing bidirectional gating: bounce unauthenticated requests on
  `/dashboard/*` to `/login?from=<path>`, bounce authenticated
  requests on `/login` to `/dashboard`. This was a Day 1 file that
  hadn't been wired all the way through.
- `login` Server Action now reads the `from` field, validates it via
  `safeFromPath`, and redirects there instead of unconditionally to
  `/dashboard`.
- `app/login/page.tsx` reads `?from=` from the URL via
  `useSearchParams` (wrapped in a Suspense boundary per Next 14+
  requirement), forwards as a hidden form input.
- Defence-in-depth still in place: every page-level Server Component
  also calls `readSession()` and redirects on miss. Proxy handles
  signed-in-or-not; pages handle role-of-signed-in-user.

### Open-redirect safety

`safeFromPath` is a small allowlist validator on the server side.
Rejects values that fail any of:

- Doesn't start with exactly one forward slash
- Starts with `//` (protocol-relative URL pointing off-site)
- Contains a backslash (Windows path separator that some parsers
  normalise to forward slash)
- Starts with `/api/` (RPC endpoints, not pages)
- Longer than 512 characters

Anything failing the gate becomes `/dashboard`. Verified by hand: a
crafted `http://localhost:3000/login?from=https://example.com` link
followed by a successful login lands on `/dashboard`, not example.com.

### Cross-platform snapshot tooling

- `scripts/snapshot.ps1` retired. Replaced by `scripts/snapshot.ts`,
  a single-file TypeScript generator run via `tsx` (already a
  devDependency since Day 1 - zero new packages added).
- Generates TWO purpose-built outputs:
  - **`docs/project-tree.md`** - file inventory derived purely from
    `git ls-files`. Cannot drift; if a file is tracked by git, it
    appears here.
  - **`docs/key-files-snapshot.md`** - curated verbatim contents of
    the highest-leverage files only. Curation list lives in
    `scripts/snapshot-config.ts`. Explicit "Coverage Drift" section
    at the bottom lists files in the source tree that AREN'T
    embedded - keeps the omission visible.
- Cross-platform: Node-based, runs on Windows / macOS / Linux. The
  PowerShell script had locked CI and any non-Windows contributor out
  of the regeneration path.
- Same `pnpm snapshot` entry point. No callsite changes anywhere
  else.

---

## What's intentionally deferred

| Item | Why deferred |
| --- | --- |
| UI consumer of `listAuditEvents` | Day 7 - the activity feed widget on the admin dashboard |
| Cross-company audit visibility (publishers seeing other companies' application events on their subcontract tenders) | Phase 1B - requires more thinking about exactly which events publishers should see and where the UI surfaces them. Out of scope for the "make audit queryable" arc |
| Tender-level events visible to applying companies (e.g. "we saw your tender get reopened") | Phase 1B - same arc as above |
| User-agent and IP capture on each audit row | Deferred per the chunk-1 design discussion. Single-tenant, on-prem-ish use case; forensic value is near zero until multi-tenant. Migration to add later is cheap |
| Soft deletes on audit-relevant entities | Out of scope. Audit retention and soft-delete semantics are entangled; better tackled as one deliberate session |
| Role gating at the network boundary | Per-page `readSession()` handles role gates. Edge would need a DB round-trip per request to enforce roles; not worth the latency for the threat model we have |
| `companies.annualTurnover` column | Carried forward from Day 4-5. Single migration + activate the existing TODO in `applyToTender`. Strong Day 8 candidate |
| Documents module (R2 + uploads + expiry reminders) | Phase 1B - 3-4 sessions of its own arc |
| Self-serve company registration | Phase 1B - own arc, pairs naturally with documents |

---

## Key decisions

**No FKs on `audit_log`.** An audit trail that vanishes when its
referent is deleted is not an audit trail. We accept dangling pointers
in forensic queries as the cost of a row that survives. `actorRole` is
denormalised on every row for the same reason - "what did admins do last
week" must answer even after the admin user is gone.

**`tender_application` joins the target-type union; `applyToTender`
stays on `tender`.** The split is about read patterns, not write
patterns. Day 7's two dominant queries on the audit log are "history
of this tender" (which wants creates, edits, publishes, closes,
awards, reopens, retracts, AND `tender_applied` events) and "history
of this application" (withdraw, decide, reinstate, recall). The first
group lives on the tender target; the second on the application. The
`tender_applied` event sits at the boundary - it's the moment a tender
acquired an application - and we put it on the tender side because
that's where the tender's history reader expects to find it. The
application's own history starts at its first state change.

**Log line before the insert.** If the DB insert fails, the log line
in the Workers log stream is the only record of the event. Putting
the log line in a `finally` block would have made it run regardless,
but that's harder to reason about than "the log always fires first,
then we try the DB." The current shape is two independent `try/catch`
blocks; either can fail and the other still runs.

**`from` not `next` for the post-login redirect.** The proxy was
already setting `?from=<path>`. We considered renaming to `next` for
consistency with my earlier middleware draft, but `from` is arguably
better (it describes where you came from, not where you're going) and
respecting the existing convention is the smaller-blast-radius choice.

**Server-side open-redirect guard, not client-side.** The login form
forwards the `from` value verbatim. The action layer is where
`safeFromPath` runs. Validation in the client is decoration; the only
gate that matters is the one between the redirect call and the value
that reaches it.

**Single hand-rolled Drizzle-side query for company audit scope, not
a correlated subquery.** Pre-resolving the caller's application id
list and ORing it into the WHERE clause is simpler to read and has the
same plan in SQLite at Phase 1 scale (a single company will have well
under 100 applications). When the row count grows enough to matter,
swap to `inArray` against a subselect.

**Custom `snapshot.ts` rather than `repomix`.** Considered swapping
to the community tool but chose a small custom generator instead.
Three reasons in priority order: (1) zero new dependencies - `tsx`
was already installed and the script is ~200 lines, (2) the project
needs TWO outputs with different lifecycles (tree always-fresh from
git, content snapshot curated from an explicit allowlist), and
repomix is purpose-built for "one big content blob" not this
split, (3) keeping the snapshot logic in-tree means it can evolve
with the project's conventions without an external dependency to
chase. Repomix remains a reasonable fallback if the in-house script
grows enough that the maintenance burden flips.

---

## Discoveries and unplanned work

### The `__drizzle_migrations` bookkeeping was corrupt

After the Chunk 1 schema change, `pnpm db:migrate` exited with code 1
and no diagnostic output. Drizzle Kit's migrate command swallows the
underlying SQLite error and only surfaces the exit code.

Inspecting the local database revealed two compounding issues:

1. Only three rows in `__drizzle_migrations` despite four migration
   files (`0000` through `0003`) being physically applied to the
   schema. The fourth migration (`0003_elite_gambit`, the
   `tender_applications` table) ran successfully back on Day 4 but
   its row was never recorded.
2. The `id` column on the existing rows was `null`. The
   `__drizzle_migrations` table had been created without the
   `INTEGER PRIMARY KEY AUTOINCREMENT` constraint that Drizzle Kit
   creates today - likely an older drizzle-kit version at original
   scaffold time. NULL id was the root cause: a later AUTOINCREMENT
   would have asserted uniqueness, and the missed insert would have
   thrown loudly instead of silently dropping.

When migrate ran with the new 0004 in place, Drizzle saw the gap,
tried to re-apply 0003, hit a "table tender_applications already
exists" error, and bailed.

Resolution: rebuilt `__drizzle_migrations` in-place via a one-shot
Node script. Dropped the broken table, recreated with the correct
schema (`INTEGER PRIMARY KEY AUTOINCREMENT`), re-inserted the three
existing rows, and patched in the missing 0003 row using the SHA-256
hash from the file and the `when` timestamp from
`drizzle/meta/_journal.json`. Then `pnpm db:migrate` ran clean and
applied only 0004.

The local repair is gitignored (lives in `.wrangler/`), so this fix
doesn't propagate. The migration files and journal on disk are
correct; any fresh clone will run a clean `0000 -> 0004` sequence
against a fresh database with no drift. The risk surface from the
old NULL-id rows is gone with the rebuild.

### `proxy.ts` was already there

About two-thirds of the way through Chunk 3 implementation, the
`pnpm dev` startup threw `Error: Both middleware file "./middleware.ts"
and proxy file "./proxy.ts" are detected. Please use "./proxy.ts" only.`

`proxy.ts` was a Day 1 file - the Next 16 rename of `middleware.ts`,
already well-commented, doing bidirectional auth gating with a
correct broad matcher. The project snapshot script had it in its
file-tree section but the body wasn't dumped (root cause is the
next item), so it didn't surface in the session-opening review and
a parallel `middleware.ts` was written from scratch.

Course correction: deleted the new `middleware.ts` and the
`lib/auth/edge.ts` extraction (no longer needed since `proxy.ts` runs
on Node by default in Next 16). Kept the `from`-aware login action,
the `safeFromPath` guard, and the form changes. Net result: Chunk 3
became four edits to existing files rather than two new files plus
edits. Smaller change, no working code thrown away.

### Snapshot script was missing files - and got rewritten

Tracing back why `proxy.ts` didn't surface: the old PowerShell
`scripts/snapshot.ps1` script maintained a hand-coded list of
top-level filenames in its Section 1 ("Top-Level Config") and dumped
their contents to the snapshot output. The list still contained
`middleware.ts` (Next 15 convention) and did NOT contain `proxy.ts`
(Next 16 convention, the file we actually have). The file-tree at
the top of the snapshot DID include `proxy.ts` because that section
used a recursive walk, so the manifest was correct but the body dump
was incomplete.

This is the same class of bug as the Day-5 PowerShell-square-bracket
fix - any script that maintains its own list of paths instead of
walking the file system or `git ls-files` will drift over time. We
chose to fix the class of bug, not the instance: the script was
retired and replaced with `scripts/snapshot.ts`, a TypeScript
generator that derives the file inventory from `git ls-files` and
produces TWO outputs (tree + curated content) with explicit drift
detection. Shipped same-day as Chunks 1-3 (commit `e1d1973`).
See "Cross-platform snapshot tooling" above for what changed
mechanically and "Key decisions" for why `snapshot.ts` over
`repomix`.

---

## Known technical debt

Carried forward from prior days.

- **Timestamp format inconsistency.** Still open. SQLite
  `datetime('now')` produces `"2026-05-18 21:01:33"`; JS
  `toISOString()` produces `"2026-05-18T21:01:33.000Z"`. Both parse,
  both render correctly through `formatTimestamp`, but raw DB rows
  look inconsistent. Day 5's state-machine parsers normalise both,
  so the bug surface is contained.

- **`companies.annualTurnover` column.** Still missing. The
  `applyToTender` turnover gate is still stubbed with a TODO.

- **`listTenders` company-role draft visibility.** Still uses a JS
  post-filter rather than a SQL OR clause. Fine at Phase 1 scale.

- **`markAwarded` doesn't capture the winning company.** Awaits the
  `awardedCompanyId` column when Phase 2 (project tracking) lands.

- **Edit-page banner copy on reopened tenders.** Still reads as if
  "only internal notes editable" is the permanent fate, doesn't
  acknowledge Reopen exists. Cosmetic.

- **No FK on `audit_log.actor_id` or `target_id`.** Deliberate
  choice, but worth noting that forensic queries joining audit rows
  against `users` or `tender_applications` need to handle
  potentially-missing referents (left join, defensive handling on
  the read side). The Day-7 activity-feed widget will be the first
  consumer to deal with this.

---

## What's next

Day 7's headline thread is **dashboard activity feed widget** -
the first UI consumer of `listAuditEvents`. The function exists,
types are right, role scoping is implemented; what's missing is a
visual surface. Suggested scope:

1. **Activity feed widget on `/dashboard`** - a card showing the
   most recent N events with iconography per verb. For admin/staff,
   the platform-wide feed; for company-role users, their own feed
   (own actions + own application events).
2. **Per-entity history tabs** - small "History" tab on tender
   detail and company detail pages, filtered to that entity's
   target_id. Same `listAuditEvents` call, narrower filter.
3. **Filter chips on the feed** - "Reversals only", "My team only"
   - small, predicate-based, no new schema.

The big open design question for Day 7 is **how to resolve target
IDs to human-readable names** in the feed rows. Audit rows store
UUIDs; the widget wants to render "Acme Construction Pvt Ltd".
Options span (a) join inside `listAuditEvents`, (b) N+1 lookups in
the Server Component, (c) render UUID + make the row clickable, (d)
capture the name in `metadata.targetName` at write time. Worth
deciding up front rather than retrofitting.

Other Day 7 candidates (any one a reasonable thread):

1. **Activity feed** (above)
2. **`companies.annualTurnover` migration** - single column, single
   activated TODO in `applyToTender`. Small but visible value.
3. **Documents module kickoff** - R2 bucket, schema, presigned-URL
   upload flow. First session of a 3-4 session arc.

The snapshot tooling is settled - no further tooling work needed
to start the day.

---

## How to run it locally

```powershell
# From the repo root
pnpm install
pnpm dev
# App at http://localhost:3000

# Default seeded users
# admin@consultway.local   / ChangeMe123!  (Admin role)
# staff@consultway.local   / ChangeMe123!  (Staff role)
# acme@example.local       / ChangeMe123!  (Company role, linked to Acme Construction)
```

To verify the Day 6 work end-to-end:

1. Sign in as admin, edit any company, save. Query the local DB to
   confirm a row landed:

   ```powershell
   # One-shot inspection via better-sqlite3 (already a dev dep).
   @'
   const db = require('better-sqlite3')('./.wrangler/consultway-local.sqlite', { readonly: true });
   console.log(db.prepare("SELECT action, target_type, datetime(created_at) AS at FROM audit_log ORDER BY created_at DESC LIMIT 5").all());
   '@ | Set-Content -Encoding UTF8 inspect.js
   node inspect.js
   Remove-Item inspect.js
   ```

2. Log out. Hit `http://localhost:3000/dashboard/companies` directly
   in an incognito window. Should bounce to
   `/login?from=%2Fdashboard%2Fcompanies`.

3. Log in. Should land on `/dashboard/companies`, not `/dashboard`.

4. Log out. Hit `http://localhost:3000/login?from=https://example.com`,
   log in. Should land on `/dashboard` (the open-redirect guard
   rejected the off-site URL).

5. Logged in, hit `http://localhost:3000/login` directly. Should
   bounce to `/dashboard` (proxy's bidirectional gating).

6. Regenerate the snapshot to confirm the new tooling works:

   ```powershell
   pnpm snapshot
   # Should write docs/project-tree.md and docs/key-files-snapshot.md
   # without prompting. No PowerShell-specific flags. Cross-platform.
   ```

---

## Commits shipped today

```
e1d1973  chore(tooling): replace snapshot.ps1 with cross-platform TS generator
875e5ef  feat(auth): wire post-login redirect through proxy from= round-trip (Chunk 3)
78d67b3  feat(audit): add listAuditEvents read API with role scoping (Chunk 2)
87e847f  feat(audit): persist audit_log to D1 (Chunk 1)
```

Plus the Day 6 wrap commit which will contain the regenerated project
snapshot (`docs/project-tree.md` and `docs/key-files-snapshot.md`)
and this report.
