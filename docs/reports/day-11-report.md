# Day 11 — Documents UX polish, tech-debt sweep, Phase 1 close-out, undo verify/reject

_Date: 2026-05-23_

## Scope

Land the polish + close-out work Day 10's report flagged, with a small
ad-hoc add-on near the end (undo verify/reject). Four deliverable
chunks landed as separate commits on `dev`:

1. **Tech-debt sweep.** ActionResult lift to a shared types module,
   doc-sync passes against current code, env placeholder warnings.
2. **Documents UX polish.** Toast notifications via sonner, filter bar
   on the documents section, document detail side-sheet.
3. **Phase 1 close-out.** Seed data expansion (realistic document
   fixtures), 404 + app-level error boundary, README demo credentials,
   skeleton-loader audit on list pages.
4. **Undo verify/reject** (ad-hoc add-on). Toast action button to
   reverse an accidental review click within an 8-second window.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` 169/169 green, `pnpm db:seed` clean + idempotent on
re-run (18 fixtures created → 18 skipped), env placeholder warnings
fire as expected on every `tsx`-based script invocation.

## What shipped

### Chunk 1 — Tech-debt sweep (commit `47a6d6d`)

**`lib/types/action-result.ts` — single source of truth** for the
generic `ActionResult<T>` union. Refactored four consumers to import
from it: `lib/companies/actions.ts`, `lib/tenders/actions.ts`,
`lib/documents/actions.ts`, `lib/documents/reads.ts`. Each file lost
its local 3-line type declaration plus the explanatory header comment;
collectively about 50 lines deleted, replaced by 5 import lines.

Two existing variants stay local with explicit rationale in the new
module's docstring:

- `lib/auth/actions.ts` keeps its narrower `field?: "email" | "password" | "form"`
  union — the constrained shape is load-bearing for the login form's
  field-focus behaviour.
- `lib/audit/log.ts::AuditReadResult` stays a leaf-friendly local type
  per the existing comment ("audit module should not have an upward
  dependency on domain modules").

**`lib/env.ts` startup warnings** — when any of
`JWT_SECRET / PASSWORD_PEPPER / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
R2_SECRET_ACCESS_KEY` still holds its dev-only placeholder default at
module load, `console.warn` fires with a one-liner pointing at the
real failure mode (sessions not portable, hashes invalidated, R2
requests will fail at sign time). Suppressed under `NODE_ENV=test` so
the test runner's stderr stays clean. Uses `console.warn` directly
(not the structured logger) because `lib/logger.ts` itself depends on
`lib/env`, so pulling the logger in here would create a circular
import — same exception pattern as the existing validation-failure
`console.error`.

**Doc syncs:**

- `docs/05-database-schema.md` — `DocumentStatus` widened from 4 to 5
  values (adds `pending`), and a new "Status values:" subsection
  documents each state with its lifecycle.
- `docs/08-rbac-matrix.md` — corrected the "Delete document" company-
  user note from "`pending_review` or `rejected`" to "`pending`
  (pre-confirm orphan) or `rejected`". Code says pending; the matrix
  was wrong since Day 9.
- `docs/03-development-phases.md` — added a cadence-drift callout near
  the top noting that real session cadence has slid from the original
  21-day plan, and pointing readers at `docs/reports/` as the
  authoritative session record.

Tests unchanged: 159 → 159 green. The ActionResult lift is structurally
identical so no behaviour-level test catches a regression in either
direction.

### Chunk 2 — Documents UX polish (commit `3ed8f52`)

**sonner toast layer.** `pnpm dlx shadcn@latest add sonner sheet`
installed sonner and the shadcn Toaster wrapper (`components/ui/sonner.tsx`),
plus the Sheet primitive (`components/ui/sheet.tsx`). `<Toaster />`
mounted in `app/layout.tsx` after children with `richColors closeButton`
flags. `document-download-button.tsx` and `document-row-actions.tsx`
were rewritten to drop their inline error pills and use
`toast.error(title, { description })` for failures plus `toast.success()`
for confirmation feedback on verify / reject / delete / download.

Side effect: `shadcn add sonner` pulled `next-themes` in as a
transitive (the template uses `useTheme()` to detect light/dark for
the Toaster). Kept the dep — Day 2's plan mentions `next-themes` for
the eventual dark/light toggle, and `useTheme()` returns `"system"`
without a ThemeProvider, so the Toaster works fine today and is
ready when the toggle lands.

**Filter bar in the documents-section header** —
`app/dashboard/companies/[id]/_components/documents-filters-bar.tsx`.
Status + document-type dropdowns, mirroring `_components/filters-bar.tsx`
in the companies route segment. URL state lives under namespaced keys
(`?documentStatus=...&documentType=...`) so future filter sets on
other sections of the company-detail page can coexist without
collision. `page.tsx` now accepts `searchParams`, narrows the values
against the schema enums via a `parseStatus`/`parseType` runtime
guard, and threads them through `DocumentsSection` to
`listDocumentsForCompany`. The Suspense boundary is keyed on
`${statusFilter ?? ""}|${documentTypeFilter ?? ""}` so a filter change
re-keys the boundary and the skeleton flickers during re-fetch
(rather than holding the previous list silently). The empty state
gets a filters-active flavour ("No documents match the current
filters") with a `Filter` icon swap.

**Document detail side-sheet** —
`components/documents/document-detail-sheet.tsx`. Client Component
owning its open state. Triggered by a new "View details" (Eye icon)
button on each row, sitting left of the Download button. Lazy-fetches
the enriched detail (uploader + reviewer names via `getDocumentDetail`)
on first open per row; subsequent opens reuse the cached fetch. The
sheet renders fields from the live detail when loaded, falling back
to the row data we already have so the layout is populated
immediately and only the "Uploaded by / Reviewed by" lines wait on
the network. Shows: file size + MIME type, issued + expiry dates with
the days-to-expiry coloured affordance, uploader/reviewer names with
dates, and review notes (already redacted server-side for company-
role callers — no client-side branching needed). Download CTA in the
footer for non-`pending` rows.

**Loading skeleton updated** —
`documents-section-loading.tsx` gained a filter-bar placeholder so
the populated card height doesn't shift when filters change.

### Chunk 3 — Phase 1 close-out (commit `54e2591`)

**Seed expansion.** `scripts/seed.ts` gained a
`DOCUMENTS_PER_COMPANY` fixture map and a `seedDocumentsForCompany`
helper. 18 realistic document fixtures across the 5 client companies
(Acme: 5, BuildRight: 4, GreenTech: 3, Acme-BuildRight JV: 3,
Modern-Alpha: 3). Coverage:

- All 7 `DocumentType` values exercised at least once
- All 5 `DocumentStatus` values exercised (skipping `pending` — that's
  the upload-in-flight orphan state, not demo-meaningful)
- Mixed expiry profiles: no-expiry (PAN, incorporation, board res),
  long-future (GST at +280/+410), near-expiry warning (+18 days),
  past-expiry already flipped to `expired` (-45 days), out-of-window
  but still in future (+95/+215 days)
- Reviewer notes on a verified row (GST cross-check note), on a
  rejected row (uploader-actionable fix), and on the past-expiry
  Modern-Alpha environmental clearance
- Uploader emails resolve to seeded user UUIDs at seed time;
  `acme@example.local` uploads its own (company-role pattern), staff
  and admin upload on behalf of other companies
- Idempotency: `(company_id, file_name)` pair. Re-running seeds the
  delta only; `pnpm db:seed` ran twice in the session — first run
  created 18 docs, second run skipped 18.

The `file_key` values point at R2 keys that don't exist in the dev
bucket — downloads will return 404 from R2, but the rest of the UI
(list, filter, side-sheet, verify/reject) works against metadata
alone. Demo-quality metadata; "stage real fixtures into R2" is a
future task.

**404 + app-level error boundary.** `app/not-found.tsx` (catch-all
404 for anything outside `/dashboard/**` — segment-level boundaries
inside dashboard still take precedence) and `app/error.tsx` (topmost
error boundary). Both render outside the dashboard layout with a
back-to-dashboard CTA. The error boundary forwards `error.digest`
plus the error to the browser console for developer visibility and
displays the digest to the user for support correlation.

**README demo credentials.** New top-level "Demo Credentials" section
with the three role logins (`admin@consultway.local`,
`staff@consultway.local`, `acme@example.local`, all sharing
`ChangeMe123!`) and a "Things to try" subsection walking the Phase-1
surface in tour order — sign in as admin, browse the roster, click
into Acme, hover for the details sheet, exercise verify/reject as
staff, switch to the company-role user and see the redacted view.
TOC updated with the new section, and Quick Start's seed step now
points at this section instead of an outdated email.

**List-page Suspense.** Extracted
`listCompanies` / `listTenders` calls into two new Server Component
children:
`app/dashboard/companies/_components/companies-table-section.tsx` +
`app/dashboard/tenders/_components/tenders-table-section.tsx`.
Each owns its own ok/!ok branching (error returns an Alert, ok returns
the populated table). Page Server Components are now header-and-card
shells with zero awaits beyond `searchParams` + `readSession`. A new
shared `components/dashboard/table-section-loading.tsx` skeleton
(rows × columns of pulse rectangles plus a pagination strip) serves
as the Suspense fallback for both. Boundary keyed on
`JSON.stringify(params)` so filter or page changes trigger a fresh
fallback flicker.

### Chunk 4 — Undo verify/reject (commit `e129d43`)

Ad-hoc add-on requested mid-session. The verify/reject success toast
now renders an "Undo" action button that reverses the review within
an 8-second window (extended from sonner's 4-second default
specifically for the undoable two; delete + download keep the
default).

**New audit verb** `document_review_reverted` (lib/audit/log.ts +
schemas.ts + labels.ts). Tone `neutral` (it's a reversal, not a new
outcome); icon `RotateCcw` to tie it visually to the Day 5 tender-
reversal family.

**New schema + action.** `revertDocumentReviewSchema` (documentId +
optional `reason` for context) + `revertDocumentReview` Server Action
in `lib/documents/actions.ts`. Auth gate mirrors verify/reject
(admin/staff via `requireReviewAuthority`). Accepts only `verified`
or `rejected` rows. Mutation: flip status → `pending_review`; clear
`reviewedBy`, `reviewedAt`, `reviewNotes` so the row is
indistinguishable from a fresh upload awaiting review. Audit's
before-snapshot captures the cleared review trail so a "show me
everything that was undone" query is possible. The optional reason
rides in metadata, NOT in reviewNotes (which is being cleared).

**UI surface.** `DocumentRowActions`' `runAction` helper grew an
optional `{ undoable: boolean }` flag. When set, the success toast
renders `action: { label: "Undo", onClick: handleUndo }` with
`duration: 8000`. The undo handler calls `revertDocumentReview` and
surfaces its own success/error toast. Stale undos (toast clicked
after the row was already re-reviewed by another tab) are caught by
the server-side status guard with a clean "Cannot undo - document is
${status}, not verified or rejected" refusal.

**10 new tests** in `lib/documents/__tests__/review-actions.test.ts`:
happy paths for admin-revert-verified and staff-revert-rejected,
optional reason in metadata assertion, refusals for not-signed-in /
company-role / not-found / already-pending_review / pending state,
audit before-snapshot shape assertion (capturing reviewer + reviewedAt
+ reviewNotes), and a stale-undo guard test that simulates a
re-review between the toast appearing and the undo click.

**Seed nudge.** Acme Mumbai Trade License changed from `status:
"verified"` to `status: "pending_review"`. Kept the +18-day expiry
date — the list-view warning affordance still colours by expiry
regardless of status. The reason for the change is in Gotchas below.

## Key decisions

**Lift only the generic `ActionResult<T>` — leave `lib/auth` and
`lib/audit` variants alone.** Both have load-bearing reasons to stay
local. Auth's `field` is a constrained union (`"email" | "password" |
"form"`) that loses precision under the generic. Audit's `AuditReadResult`
is intentionally a leaf-friendly local type so the audit module never
acquires an upward dependency on a domain module. Documenting these
exclusions inline in the new module's docstring beats the temptation
to "centralise everything" and lose the per-shape reasoning.

**URL-state filters under namespaced keys (`documentStatus`, not
`status`).** The company detail page may grow additional filter
clusters on other sections (activity feed, projects sub-section in
Phase 3). Namespacing today is cheaper than retrofitting later when
a real collision lands.

**One sheet per row, lazy-fetched on first open.** The alternative is
one global sheet driven by a "currently-opened documentId" piece of
state, with the trigger setting it. That centralises focus management
worries (Radix's focus-trap takes care of the per-row variant) and
adds reducer-shaped state for a small benefit. Co-located sheets are
~30 lines bigger per row but each is independently keyboard-
discoverable and the focus-restore-to-trigger behaviour is automatic.

**Suspense boundary keyed on serialised searchParams.** Without a key,
Next.js holds the previous Server-Component output silently during
re-fetch — fine for fast queries but confusing during slow ones
because the user has no signal that anything is loading. Keying on
`JSON.stringify(params)` re-renders the boundary on every filter or
page change, so the skeleton flicker is the visual handshake.
Suboptimal on rapid-fire filter changes (every keystroke would
re-flicker if search were debounced too aggressively) but the
documents filters are select-dropdown-only, not text-input, so each
change is an intentional commit.

**8-second toast for undo (not 4s, not "until clicked").** sonner's
default 4s isn't enough to read "Verified · Undo" and react before
auto-dismiss. "Until clicked elsewhere" creates a sticky-affordance
problem (multiple stacked toasts as the user verifies several docs in
succession). 8s is the read-and-decide window without being
distracting if you intended the verify and want to keep moving.

**Server-side status guard, not client-side timestamp guard.** The
toast lifetime IS the window; if the toast is gone, the affordance is
gone. No need for the action to refuse based on "how long ago did the
review happen". The status check is the only race-protection that
matters: by the time a stale undo fires, the row may have moved on
(re-reviewed in another tab), and the check catches that with a clean
error toast.

**Seed nudge to keep the demo + tests both passing.** The original
"verified + near-expiry" combo on the Acme trade license was the
ideal demo case for the expiry warning affordance — but the cron test
sweeps all `verified` rows globally and would double the reminder
count when that row exists. Three options:
(a) wipe documents in the test's beforeEach (destroys user's seed
on every run, also dangerous under parallel test files),
(b) modify the cron to accept a company filter (invasive production
change for test convenience),
(c) shift that one row to `pending_review` (the visual affordance
still works, and the cron's verified-only filter excludes it).
Chose (c). The deeper fix is `:memory:` SQLite for tests, flagged as
a Day-12 candidate.

## Gotchas surfaced

**Seed data contamination of the cron test.** Day 10's seed had no
documents, so the expiry-sweep cron test ran against an empty global
documents pool plus its own fixture. Day 11's seed expansion added
verified rows, and one (Acme trade license at +18 days) landed inside
the cron's 30-day reminder window. Re-running the test suite after
`pnpm db:seed` doubled every "expected 1 send" assertion to 2 and
"expected 2" to 4. The cron's query is intentionally global (it
sweeps all verified rows in the system); the test isn't isolated
because all tests share the same SQLite file via `env.DATABASE_URL`.
Worked around by changing the offending fixture's status. Real fix
is `:memory:` SQLite for tests.

**`pnpm db:seed` is idempotent on `(company_id, file_name)`, NOT on
all columns.** When I needed to change the Acme trade license's
status after seeding, the seed wouldn't update the existing row — it
would just skip it. Required a one-off `sqlite3 ... DELETE FROM
documents WHERE file_name = '...'` then a re-seed to pick up the
corrected status. A more sophisticated seed could compute a hash of
each fixture and update-on-drift; not worth the complexity at Phase 1.

**`shadcn add sonner` brings `next-themes` as a transitive.** The
template uses `useTheme()` so the Toaster matches the active theme.
Without a `<ThemeProvider>`, the hook returns `"system"` and the
Toaster honours the OS preference. Kept the dep — Day 2's plan
already had `next-themes` slated for the dark/light toggle.

**Server-action modules with `"use server"` CAN re-export types.**
The existing `lib/documents/reads.ts` had a comment claiming
otherwise ("Next.js server-action files can only export async
functions — re-exporting a type from a sibling file is fine, but
keeping it inline here matches how `./actions.ts` declares it
locally"). Tested by importing the new `ActionResult` from a typed
module into `reads.ts` and Drizzle's type system / Next.js compile
were both happy. The original comment's premise was wrong, but the
practical advice (keep types in a leaf module, not a server-action
module) holds.

**Audit verb additions are a three-file pattern, not two.** Adding
`document_review_reverted` required edits to `lib/audit/log.ts` (the
union type), `lib/audit/schemas.ts` (the Zod enum mirror), AND
`lib/audit/labels.ts` (the icon + verb + tone Record). Forgetting
any one of the three would either compile-fail (the labels Record is
keyed by the union, so a missing verb is a TS error) or runtime-fail
(Zod rejecting an unknown action). The compile-fail catches most
slips; documenting the three-file pattern in the audit module's
docstring would save future-Mayur a minute.

**Empty git-add globs.** `git add app/dashboard/companies/[id]/...`
on Windows-with-bash was interpreted literally by git — the
square brackets in the path needed quoting. The actual brackets in
the Next.js dynamic-segment path tripped up shell glob expansion.
Quoting the path with double quotes worked.

## Surfaces touched

```
# Chunk 1 — Tech-debt sweep (commit 47a6d6d)
lib/types/action-result.ts                                          (new)
lib/companies/actions.ts                                            (modified - ActionResult import)
lib/tenders/actions.ts                                              (modified - ActionResult import)
lib/documents/actions.ts                                            (modified - ActionResult import)
lib/documents/reads.ts                                              (modified - ActionResult import)
lib/env.ts                                                          (modified - placeholder warnings)
docs/03-development-phases.md                                       (modified - cadence callout)
docs/05-database-schema.md                                          (modified - DocumentStatus + notes)
docs/08-rbac-matrix.md                                              (modified - delete row fix)

# Chunk 2 — Documents UX polish (commit 3ed8f52)
components/ui/sonner.tsx                                            (new - shadcn add)
components/ui/sheet.tsx                                             (new - shadcn add)
components/documents/document-detail-sheet.tsx                      (new)
app/dashboard/companies/[id]/_components/documents-filters-bar.tsx  (new)
app/layout.tsx                                                      (modified - Toaster)
app/dashboard/companies/[id]/page.tsx                               (modified - searchParams + Suspense key)
app/dashboard/companies/[id]/_components/documents-section.tsx      (modified - filter props + filter-bar mount)
app/dashboard/companies/[id]/_components/documents-section-loading.tsx (modified - filter-bar placeholder)
app/dashboard/companies/[id]/_components/documents-list.tsx         (modified - view-details button)
components/documents/document-download-button.tsx                   (modified - toast)
components/documents/document-row-actions.tsx                       (modified - toast)
package.json                                                        (modified - sonner, next-themes)
pnpm-lock.yaml                                                      (modified)

# Chunk 3 — Phase 1 close-out (commit 54e2591)
app/not-found.tsx                                                   (new)
app/error.tsx                                                       (new)
components/dashboard/table-section-loading.tsx                      (new)
app/dashboard/companies/_components/companies-table-section.tsx     (new)
app/dashboard/tenders/_components/tenders-table-section.tsx        (new)
scripts/seed.ts                                                     (modified - +~430 lines doc fixtures)
README.md                                                           (modified - Demo Credentials + TOC)
app/dashboard/companies/page.tsx                                    (modified - Suspense + extracted)
app/dashboard/tenders/page.tsx                                      (modified - Suspense + extracted)

# Chunk 4 — Undo verify/reject (commit e129d43)
lib/audit/log.ts                                                    (modified - new verb)
lib/audit/schemas.ts                                                (modified - new verb)
lib/audit/labels.ts                                                 (modified - new verb)
lib/documents/schemas.ts                                            (modified - revertDocumentReviewSchema)
lib/documents/actions.ts                                            (modified - revertDocumentReview action)
components/documents/document-row-actions.tsx                       (modified - Undo action button + 8s)
lib/documents/__tests__/review-actions.test.ts                      (modified - 10 new tests)
scripts/seed.ts                                                     (modified - Acme trade license status nudge)
```

## Test totals

Before this session: **159 tests across 7 files**, all green (Day 10
report's end state).

After this session: **169 tests across 7 files**, all green every
run. Net: +10 tests, all in `lib/documents/__tests__/review-actions.test.ts`
covering the new `revertDocumentReview` action. No tests in the UI-
only chunks (toast / filter bar / side-sheet are presentation; the
filter URL-state round-trip wasn't tested per the briefing's "if you
can swing it"). No tests for the seed-data expansion or the
404/error boundaries (UI shells, not asked for).

## Followups for Day 12+

**Test infrastructure:**

1. **Switch tests to `:memory:` SQLite** for proper isolation. The
   expiry-sweep test's vulnerability to seed-data contamination is
   evidence that the shared dev DB is the wrong test substrate. A
   per-test-process in-memory DB with migrations applied at setup
   would make the tests deterministic regardless of dev DB state and
   independent of `pnpm db:seed` interference.

**Carry-forward from earlier sessions (still outstanding):**

2. **`reminders_sent` dedup table** + Drizzle migration + update to
   `expiry-sweep.ts` so the same reminder doesn't go out every day
   for the same in-window document. Day 10 followup; deferred from
   Day 11 (briefing marked stretch, and chose to keep Chunk 1 tight).
   Schema is documented in `docs/05-database-schema.md` already
   (table with `(document_id, reminder_kind)` unique key).
3. **Wrangler cron config + `scheduled()` worker entry point** that
   calls into `runExpirySweep` and `runPendingCleanup`. Both handlers
   are designed for direct invocation; the wrangler wiring is a
   deployment-session concern.
4. **Resend domain verification + `EMAIL_FROM` pointed at a real
   verified sender.** Production-deploy task. `RESEND_API_KEY` empty
   in `.env.local` means email is in log-fallback mode locally.

**Surfaced this session:**

5. **`reviewNotes` rendering in the side-sheet on company-role
   viewers** — `getDocumentDetail` redacts the field to null
   server-side. The current sheet's `liveDocument.reviewNotes` check
   handles this correctly. Manually verify on the next browser session.
6. **Sheet vs side-by-side detail view at desktop widths.** The
   current sheet slides in from the right at `sm:max-w-md` (~28rem).
   On wide screens, a permanently-pinned detail pane might be more
   useful for staff doing rapid-fire reviews. Not a regression — just
   an open design choice for Phase 2.
7. **Seed self-healing on changed fixtures.** Currently
   `seedDocumentsForCompany` is idempotent on `(company_id,
   file_name)` only — changing other fields in the seed source
   doesn't update the existing row, requiring manual deletion. A
   hash-based "fixture has drifted from seed source" detector would
   automate this; cost-benefit is marginal at Phase 1's seed size.
8. **`pnpm db:reset` script.** Mentioned in README's Scripts table
   ("`pnpm db:reset` — ⚠️ Wipe local DB + re-migrate + seed") but
   doesn't actually exist in `package.json`. Either add it, or strip
   the reference from the README. Surfaced while writing the demo
   credentials block but didn't trip anyone yet.

**Already-resolved this session:**

- Day 10 followup #1 (`ActionResult<T>` centralisation) — done.
- Day 10 followup #2 (`docs/05-database-schema.md` DocumentStatus) — done.
- Day 10 followup #3 (`docs/03-development-phases.md` cadence drift) — done.
- Day 10 followup #4 (RBAC matrix Documents row sanity-check) — fixed
  the actual discrepancy (delete row column).
- Day 10 followup #5 (env validator placeholder warnings) — done.
- Day 10 followup #6 (toast / sonner introduction) — done.
- Day 10 followup #10 (document detail page UI consumer) — done as
  the side-sheet.
- Day 10 followup #11 (filter UI in documents-section header) — done.

## Carry-forward to Day 12

- **Phase 1 is now functionally close to done.** Auth, RBAC,
  companies (CRUD + roster + detail), documents (upload, list,
  detail, filter, review, undo, expiry-sweep, pending-cleanup) are
  all wired and tested. The polish bucket from the original Day-10
  plan is now mostly delivered; what remains is the production-
  deploy hygiene (Resend domain, wrangler cron config, real R2
  fixtures if we want functional downloads in the demo).
- **`dev` is 4 commits ahead of `origin/dev`** at session end:
  `47a6d6d`, `3ed8f52`, `54e2591`, `e129d43`. Push when ready
  (would need explicit approval per `<permissions>`).
- **169 tests passing on every run.** No flakes observed across the
  session's ~6 test runs.
- **Local DB is seeded** with 18 document fixtures across 5
  companies. `acme@example.local` company-role user is linked to Acme
  Construction Pvt Ltd, which has 5 documents covering the full mix
  of statuses and expiry profiles. Side-sheet + filter bar + verify/
  reject + undo can all be exercised against this dataset.
- **`PASSWORD_PEPPER=dev-only-pepper-replace-in-prod`** is still in
  `.env.local`. Do NOT change without re-seeding (the seeded users'
  bcrypt hashes are pepper-bound).
- **`RESEND_API_KEY` still empty** in `.env.local` — email is in
  log-fallback mode. Setting it + pointing `EMAIL_FROM` at a verified
  sender is a deployment-prep task.
- **Phase 2 (Tenders & Notifications) is the next natural target.**
  Day 11 in the original phase doc is "Tender data model + admin
  CRUD" but the cadence-drift callout now records that real sessions
  have slid. Day 12 should either pick up that Phase-2 work or
  whatever the deployment-prep / final-polish bucket suggests is more
  load-bearing.

That's Day 11.
