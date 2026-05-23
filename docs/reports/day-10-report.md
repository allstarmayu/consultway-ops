# Day 10 — Documents module: list, download, review workflow, expiry crons

_Date: 2026-05-23_

## Scope

Land the full operational surface for the documents module on top of
Day 9's upload foundation. Three deliverable chunks, in order:

1. **Read surface.** List + detail + download Server Actions, plus the
   Documents section on the company detail page (replacing Day 9's
   proof-of-concept header button).
2. **Review workflow.** verify / reject / delete Server Actions with the
   staff/admin UI to drive them, including audit verb additions and the
   R2 object delete cascade.
3. **Cron handlers.** Daily expiry-sweep (flip past-expiry + reminder
   emails) and pending-row cleanup, behind a real Resend client with a
   log-fallback path for dev.

Each chunk was test-driven against the in-memory SQLite + mocked R2;
all 159 tests across seven files pass on every run after a stabilisation
fix in Chunk 3.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` green eight runs in a row,
`pnpm cron:pending-cleanup` smoke-ran cleanly against the dev DB.

## What shipped

### Chunk 1 — Read surface

**Server Actions split into a new `lib/documents/reads.ts`** to keep the
write-side `actions.ts` from creeping toward a 900-line file. Three
actions, all routing through `sessionCanAccessDocumentForCompany` from
Day 9's `lib/documents/auth.ts`:

| Action | Caller | Behaviour |
|---|---|---|
| `listDocumentsForCompany` | admin/staff (any company); company-role (own only) | role-scoped list with optional `status` + `documentType` filters, sort by `uploadedAt / expiresAt / documentType / status`, no pagination at Phase 1 scale |
| `getDocumentDetail` | same gate | single row + joined uploader name + reviewer name; strips `reviewNotes` for company-role callers |
| `generateDocumentDownloadUrl` | same gate | presigned R2 GET URL via `getPresignedGetUrl`, 5-min expiry, refuses `pending` rows (no bytes in R2 yet) |

Cross-company company-role surfaces as "Document/Company not found",
matching the existing anti-enumeration pattern from companies/tenders.

**Schemas in `lib/documents/schemas.ts`** — `listDocumentsForCompanyQuerySchema`,
`documentSortBy/Dir` enums (mirroring DB columns), `documentByIdInputSchema`
shared between detail + download (both take only `{ documentId }`).

**UI on the company detail page**, mounted below the overview Card and
wrapped in `<Suspense>` for independent streaming:

- `_components/documents-section.tsx` — fetches via `listDocumentsForCompany`,
  renders header strip with "Documents (N)" + Upload button, empty state,
  or list. Error branch surfaces an Alert.
- `_components/documents-list.tsx` — pure presentation; per-row filename,
  type + status badges, uploaded date, expiry affordance ("expires in N
  days" / "expired N days ago" / "no expiry") coloured by urgency, Download
  button, and a slot for the review affordances.
- `_components/documents-section-loading.tsx` — skeleton fallback.

**Cross-route UI primitives in `components/documents/`** — `document-type-badge.tsx`,
`document-status-badge.tsx` (mirroring the existing ComplianceBadge pattern),
and `document-download-button.tsx` (Client Component calling the download
action via `useTransition`, opening the signed URL in a new tab).

**Labels lifted to `lib/documents/labels.ts`** — `DOCUMENT_TYPE_LABELS` +
`DOCUMENT_STATUS_LABELS` keyed by their union types so a new enum value
produces a TS error here. Upload form re-pointed to the shared module.

**Company header reverted** — the Day 9 proof-of-concept Upload button was
removed from `company-header.tsx`; the Documents section's header is now
the entry point. The `canUploadDocument` prop was deleted.

**28 new tests** in `lib/documents/__tests__/reads.test.ts` cover the
full RBAC matrix per action, filter/sort behaviour, redaction, and the
R2 + session mocks.

### Chunk 2 — Review workflow

**Three new audit verbs** in `lib/audit/log.ts` + `schemas.ts` + `labels.ts`:
`document_verified`, `document_rejected`, `document_deleted`. Briefing
incorrectly claimed verified+rejected were already in the schema from
Day 6; they were not. `document_expired` was already present (added
speculatively by Day 9) and gets used in Chunk 3.

**`deleteR2Object(key)` helper** added to `lib/r2/client.ts`. Signs and
executes a DELETE against R2 via aws4fetch (no presigned URL — the
server does the request directly). Idempotent per S3 semantics. Returns
`{ ok, status }`; logs non-2xx but does NOT throw, so callers can
proceed with the DB delete even if R2 has a moment.

**Three new Server Actions** in `lib/documents/actions.ts`:

| Action | Authority | Effect |
|---|---|---|
| `verifyDocument(documentId, notes?)` | admin/staff only | `pending_review` → `verified`; stamps `reviewedBy` + `reviewedAt`; optional notes captured in `reviewNotes`. Non-idempotent (refuses re-verify of already-verified). Audit verb: `document_verified`. |
| `rejectDocument(documentId, reason)` | admin/staff only | `pending_review` → `rejected`; required reason (≥5 chars, ≤500) lands in `reviewNotes` + audit metadata so the uploader knows what to fix. Audit verb: `document_rejected`. |
| `deleteDocument(documentId)` | admin always; company-role own `pending`/`rejected` only; staff blocked | deletes the DB row, then best-effort R2 delete. R2 failures logged + recorded in audit metadata (`r2DeleteOk`, `r2Status`) but do NOT roll back the DB delete. Audit verb: `document_deleted`. |

**Reusable reason primitives** (`optionalReasonSchema` / `requiredReasonSchema`)
in `lib/documents/schemas.ts`, mirroring the tenders module pattern. The
5-char floor on `required` matches `confirm-dialog.tsx`'s required-reason
client-side gate.

**`<DocumentRowActions>`** — a single Client Component owning all three
confirm-dialog instances. Self-gates visibility on viewer role + row
status (verify/reject only on `pending_review`; delete on admin always
or company-role-own-pending/rejected; nothing for staff on delete). Each
action runs through `useTransition` and triggers `router.refresh()` on
success so the status badge + section count update. Inline error pill
mirrors the download button's pattern; no toast library yet (deferred).

**`viewerRole`** threaded from `page.tsx` → `documents-section.tsx` →
`documents-list.tsx` → `DocumentRowActions` so each row doesn't re-read
the session.

**29 new tests** in `lib/documents/__tests__/review-actions.test.ts`
cover the full RBAC matrix per action, status guards, reason validation,
audit-event metadata assertions, R2 mock-call assertions, and two
"R2 delete fails / throws → DB row still deleted; audit notes r2DeleteOk=false"
tests.

### Chunk 3 — Cron handlers + email layer

**`resend@6.12.3` added** to dependencies. Three new env vars
(`RESEND_API_KEY` optional, `EMAIL_FROM` with safe placeholder default,
`EMAIL_REPLY_TO` optional) — all defaulted so the app boots without a
Resend account.

**`lib/email/client.ts`** — single `sendEmail()` entry point. When
`RESEND_API_KEY` is set, instantiates a lazy Resend client and dispatches.
When unset, logs the full rendered payload at info level so `pnpm
cron:expiry-sweep` works locally without spam. Never throws — returns
`{ ok, id }` or `{ ok, error }`. The same contract for both paths means
callers don't branch on dev-vs-prod.

**`lib/email/templates/document-expiry-reminder.ts`** — pure render
function returning `{ subject, html, text }`. Inline-styled HTML in a
single-column 600 px table layout (Outlook-safe, Gmail-safe), plus a
plain-text fallback. No React Email dep — the template is 50 lines of
HTML and a 50-line dep isn't worth the build-time cost.

**`SYSTEM_ACTOR_ID`** — exported constant (nil UUID
`00000000-0000-0000-0000-000000000000`) for system-initiated audit
events. The `AuditEvent.actorRole` union was widened to include
`"system"` so cron sweeps can audit with the correct shape. The UI
audit-feed components were checked and don't switch on role, so the
widening is non-breaking.

**`lib/documents/crons/expiry-sweep.ts`** — single daily handler doing
two passes:

1. Find rows `status = 'verified' AND expires_at <= today`, flip to
   `expired`, audit `document_expired`.
2. Find rows `status = 'verified' AND today < expires_at <= today + 30`,
   batch-fetch their companies (single IN-query, no N+1), and send a
   reminder email per row. Rows with null `contactEmail` are logged
   and counted as skipped.

Pure dependency injection — production callers pass `db`, real
`sendEmail`, today=`new Date().toISOString().slice(0,10)`, and the
app URL; tests inject mocks. Returns a typed `ExpirySweepResult` with
counts so ops can dashboard the sweep.

No dedup table for reminders — the briefing's simplified spec sends a
reminder every day a row sits in the 30-day window. Spammy by design,
flagged as a Day 11 follow-up.

**`lib/documents/crons/pending-cleanup.ts`** — deletes `documents WHERE
status = 'pending' AND created_at < now - 1h`. No R2 cleanup (bytes
never landed for `pending` rows by definition). No per-row audit (would
be noisy for abandoned uploads); one summary log line with the count
and a 10-id sample for forensics.

**Local invocation scripts** — `scripts/cron-expiry-sweep.ts` and
`scripts/cron-pending-cleanup.ts`, wired through `pnpm
cron:expiry-sweep` and `pnpm cron:pending-cleanup`. Both load
`.env.local` via `dotenv/config`, hit the real local SQLite, and print
a JSON summary. `pnpm cron:pending-cleanup` smoke-ran against the dev
DB cleanly (`deletedCount: 0` — no orphan rows in the seed).

**18 new tests** across `expiry-sweep.test.ts` (11) and
`pending-cleanup.test.ts` (7) — past-expiry flip + audit-write +
upcoming-window email + null-email-skip + send-failure tolerance +
idempotency on a second run with the same `today` / `now`.

## Key decisions

**Split `reads.ts` from `actions.ts`.** Day 9's briefing tentatively
mentioned this; I went ahead because `actions.ts` was at 452 lines after
Day 9 and Chunks 1 + 2 would have pushed it past 900 with mixed read /
write semantics. The split also lets future modules grow read-only
surfaces without re-opening the action file.

**Section, not tab.** The briefing left the choice open. Tabs are right
when there are multiple peer surfaces (Documents + Projects + Activity);
at Phase 1 with one overview card and one documents list, promoting to
tabs is all cost and no benefit. When a second tab-worthy peer lands,
the tab promotion is a small refactor.

**One `DocumentRowActions` component, not three.** Verify / Reject /
Delete each could have been their own component file. Sharing one
component means one `useTransition`, one `router.refresh`, one inline
error surface, and one place to coordinate the dialog open-state. The
self-gate is a per-button conditional inside one file — cleaner than
three near-identical wrappers.

**Non-idempotent verify/reject.** A re-verify of an already-verified row
is refused, not silently accepted. Idempotent would mean overwriting the
reviewer + timestamp — wrong on the audit trail. Same for re-reject.

**R2 delete is best-effort; DB delete wins on conflict.** An orphan R2
object (DB gone, bytes lingering) is preferable to a row referencing
missing bytes (which would 404 every download attempt). The audit row
records the R2 outcome so a future R2 sweeper can reconcile.

**`SYSTEM_ACTOR_ID` + `"system"` role for cron audits.** A nil UUID is
queryable, stable, and won't collide with any user UUID v4/v7. The role
union widening is non-breaking (UI doesn't switch on role) and means
"what did the system do" answers cleanly in the audit log.

**Stub-fallback email, not "install Resend now or block."** The Day 6
phase-doc plan was Resend wiring; that slid. Installing the SDK is
small (~30 KB, lazy-instantiated) and the same code path works in dev
(via the log fallback) and prod (with a key). Forcing every contributor
to provision a Resend account just to run the cron locally would be
worse.

**Defer wrangler cron config.** The briefing OK'd this explicitly.
`pnpm cron:*` scripts give a strictly-better local verification surface
than a deployed cron (instant vs wait-for-trigger-time), and the
`@opennextjs/cloudflare` scheduled-handler wiring entangles with the
worker entry point — that's a deployment-session concern.

**No reminder dedup table.** Briefing simplified the original Day 5
T-30/T-14/T-7/T-1 spec to "any row in the 0-30 day window." The
literal reading sends a reminder every day for an in-window doc; that's
noisy but bounded and matches what the briefing said. Day 11 can add
`reminders_sent` when noise becomes a real complaint.

## Gotchas surfaced

**Briefing claimed verify/reject audit verbs were "already in the
schema from Day 6". They weren't.** `lib/audit/schemas.ts` had only
`document_uploaded` and `document_expired` before this session. Chunk 2
added all three (verified, rejected, deleted) to the AuditAction union,
the Zod schema, and the labels map (all three records key off the
union so a missing verb is a TS error).

**Cross-format timestamp comparison in SQLite.** The schema default
`datetime('now')` writes `YYYY-MM-DD HH:MM:SS` (space separator); a
caller passing `new Date().toISOString()` writes
`YYYY-MM-DDTHH:MM:SS.sssZ` (T separator). A naive `<` over raw strings
compares lexically — and ASCII space (0x20) sorts before 'T' (0x54),
so rows in the two formats mis-compare across the boundary. Discovered
when the pending-cleanup tests flaked under parallel-test load: my
ISO-format cutoff was sweeping default-format pending rows from
concurrently-running tests. Fixed by routing both sides through SQLite's
`datetime()` function in the WHERE clause so the comparison runs on
parsed-time values. Would have surfaced in production the first time
an admin tool wrote a row with an explicit ISO `created_at`.

**vi.fn typing for assertion-on-mock-calls.** Default `vi.fn(impl)`
infers `mock.calls` as a `never[]`, so `sendEmail.mock.calls[0][0]`
fails to typecheck. Fix is `vi.fn<(args: T) => Promise<R>>(impl)` —
explicit function-shape generic. Documented inline in the expiry-sweep
test.

**`Database` is not an exported type from `lib/db`.** I tried importing
it as a type; the export there is the `better-sqlite3` `Database`
class. The pattern that works is `type Database = typeof db` re-derived
locally — and it auto-adapts to the eventual D1 driver swap.

**Logger payload typing.** `logger.info(msg, ctx)` expects `ctx` to
satisfy `LogContext` which has an index signature. Passing a typed
result object directly fails; spreading (`{ ...result }`) fixes the
shape mismatch.

## Surfaces touched

```
# Schemas + audit verb additions
lib/audit/log.ts                                         (modified)
lib/audit/schemas.ts                                     (modified)
lib/audit/labels.ts                                      (modified)
lib/documents/schemas.ts                                 (modified)
lib/db/                                                  (unchanged - no migration)

# Server Actions
lib/documents/reads.ts                                   (new)
lib/documents/actions.ts                                 (modified)

# R2
lib/r2/client.ts                                         (modified - deleteR2Object)

# Email layer
lib/env.ts                                               (modified)
.env.example                                             (modified)
lib/email/client.ts                                      (new)
lib/email/templates/document-expiry-reminder.ts          (new)

# Labels
lib/documents/labels.ts                                  (new)
components/documents/upload-form.tsx                     (modified - imports labels module)

# UI primitives
components/documents/document-type-badge.tsx             (new)
components/documents/document-status-badge.tsx           (new)
components/documents/document-download-button.tsx        (new)
components/documents/document-row-actions.tsx            (new)

# Company detail page integration
app/dashboard/companies/[id]/page.tsx                    (modified)
app/dashboard/companies/[id]/_components/company-header.tsx       (modified - removed Upload button)
app/dashboard/companies/[id]/_components/documents-section.tsx           (new)
app/dashboard/companies/[id]/_components/documents-section-loading.tsx   (new)
app/dashboard/companies/[id]/_components/documents-list.tsx              (new)

# Crons
lib/documents/crons/expiry-sweep.ts                      (new)
lib/documents/crons/pending-cleanup.ts                   (new)
scripts/cron-expiry-sweep.ts                             (new)
scripts/cron-pending-cleanup.ts                          (new)

# Tests
lib/documents/__tests__/reads.test.ts                    (new, 28 tests)
lib/documents/__tests__/review-actions.test.ts           (new, 29 tests)
lib/documents/__tests__/expiry-sweep.test.ts             (new, 11 tests)
lib/documents/__tests__/pending-cleanup.test.ts          (new, 7 tests)

# Build + deps
package.json                                             (modified - resend dep + 2 cron scripts)
pnpm-lock.yaml                                           (modified)
```

## Test totals

Before this session: 84 tests across 3 files (per Day 9 report).
After this session: **159 tests across 7 files**, all green on
8 consecutive runs. Net: +75 tests covering the documents-module read
surface, the review-and-delete workflow, and the two cron handlers.

## Followups for Day 11+

**Tech debt cleanup (worth a single dedicated commit):**

1. **`ActionResult<T>` centralisation.** Now duplicated in
   `lib/companies/actions.ts`, `lib/tenders/actions.ts`,
   `lib/documents/actions.ts`, and `lib/documents/reads.ts`. Lift to
   `lib/types/action-result.ts` and refactor the four modules to import.
2. **`docs/05-database-schema.md` — DocumentStatus widened to 5 values
   (added `pending`).** Day 9 follow-up; still outstanding.
3. **`docs/03-development-phases.md` — cadence drift.** The doc maps
   "Day 10" to "Phase 1 polish + demo"; in actual session terms Day 10
   was the documents-module operational surface. The day-by-day mapping
   in that doc is stale relative to real session cadence — flagging that
   the doc should either be re-mapped or marked as "original plan;
   sessions slid; see day reports for actual cadence."
4. **`docs/08-rbac-matrix.md` Documents row** — confirmed the verify /
   reject / delete columns are already present in the matrix; no edit
   needed.
5. **Env validator placeholder warnings.** Add startup warnings in
   `lib/env.ts` when `PASSWORD_PEPPER`, `JWT_SECRET`, or any `R2_*` value
   equals the dev placeholder. Saves future-Mayuresh another hour of
   silent-auth-failure debugging (Day 9 callout).
6. **Toast/sonner introduction.** Both `document-download-button.tsx`
   and `document-row-actions.tsx` use inline error pills as a stand-in
   for a toast system. A real toast lib (shadcn's `sonner` is the
   natural pick) would clean both up.

**Deferred from Day 10 scope:**

7. **Wrangler cron wiring.** `triggers.crons` lines in `wrangler.jsonc`
   + the `scheduled()` worker entry point that calls into
   `runExpirySweep` and `runPendingCleanup`. Both handlers are designed
   for direct invocation from any scheduled context.
8. **Reminder dedup `reminders_sent` table.** The cron currently
   re-sends every day a doc sits in the 30-day window. Original phase
   plan was T-30/T-14/T-7/T-1; if the simpler current behaviour proves
   too noisy, swap to a dedup table keyed by `(document_id, reminder_kind)`.
9. **Resend domain verification + EMAIL_FROM pointed at the real
   sender.** Production deploy task; the placeholder
   `noreply@consultway.local` is unroutable on purpose.
10. **Document detail page.** `getDocumentDetail` is wired and tested
    but has no UI consumer yet. Natural home: a side-sheet/drawer
    opened from a "View details" affordance on each row. Belongs with
    the Day 11 polish pass.
11. **Filter UI in documents-section header.** The action supports
    `status` + `documentType` + `sortBy` filters but the section just
    lists everything. A small filter bar (mirroring `filters-bar.tsx`)
    would land cleanly once a staff user accumulates enough docs to
    actually want filtering.

**Already-resolved as of this session:**

- Day 9 follow-up "Route Day 10 actions through
  `sessionCanAccessDocumentForCompany`" — done, all three reads use it.
- Day 9 follow-up "Add `document_verified` / `document_rejected` /
  `document_deleted` to the audit schema" — done.
- Day 9 follow-up "`deleteR2Object` helper" — done.

## Carry-forward to Day 11

- Phase 1 still has the "polish + demo" original-Day-10 work to land:
  empty-state illustrations, full skeleton loaders on tables, toast
  notifications, seed-data expansion, demo recording.
- The documents module is operationally complete for staff/admin
  review and company self-service; what remains for Phase 1 is mostly
  polish + the deferred Resend domain + wrangler wiring.
- Login still works as `admin@consultway.local` / `ChangeMe123!`
  against the local SQLite (Day 9 carry-forward unchanged).
- R2 bucket `consultway-docs` (account `4f604d7dc4504bacb6f8ec0d59417e08`)
  may now hold additional test objects from Chunk 2's delete-cascade
  development. Inspectable via
  `wrangler r2 bucket info consultway-docs --remote`.

That's Day 10.
