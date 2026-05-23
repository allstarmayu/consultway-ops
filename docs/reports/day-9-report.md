# Day 9 — Documents module foundation

_Date: 2026-05-22_

## Scope

Land the documents module foundation so registered companies (and
staff acting on their behalf) can upload compliance documents directly
to Cloudflare R2 from the browser, with a server-validated two-step
flow that produces auditable records. The brief calls for document
upload with expiry reminders; Day 9 ships the upload mechanic
end-to-end, deferring the list/download UI, expiry-reminder cron, and
verify/reject workflow to Day 10.

The work shipped across four commits, each independently testable and
tsc-clean:

```
[chunk 4]  feat(documents): proof-of-concept upload UI + company-detail entry point
[chunk 3]  feat(documents): initiate + confirm upload server actions
710467a    feat(r2): presigned upload/download helpers + env wiring
7d93d39    feat(documents): documents table schema + migration
```

End-to-end smoke verified through the UI: PDF picked, presigned PUT
URL minted, browser-direct upload to R2 returned 200, confirm flipped
the row to `pending_review`, `document_uploaded` audit event written,
bytes verifiable in the R2 bucket via the dashboard.

## What shipped

### New `documents` table in `lib/db/schema.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID v7 |
| `company_id` | TEXT FK | ON DELETE CASCADE — documents go with the company |
| `document_type` | TEXT | 7-value union: gst_certificate, pan_card, incorporation_cert, board_resolution, cancelled_cheque, trade_license, other |
| `file_key` | TEXT | R2 key — `companies/{companyId}/{documentId}/{sanitizedFilename}` |
| `file_name` | TEXT | Original filename, preserved for display + Content-Disposition |
| `mime_type` | TEXT | Validated against ALLOWED_MIME_TYPES allow-list |
| `size_bytes` | INTEGER | Capped at 10 MB |
| `status` | TEXT default `pending` | 5-value union: pending, pending_review, verified, rejected, expired |
| `review_notes`, `reviewed_by`, `reviewed_at` | nullable | For Day 10's verify/reject workflow |
| `issued_on`, `expires_at` | ISO date strings, nullable | For expiry-reminder cron (Day 10+) |
| `uploaded_by` | TEXT FK | ON DELETE RESTRICT — never lose the audit trail |
| `uploaded_at`, `created_at`, `updated_at` | ISO timestamps |

Four indexes: `company_id`, `status`, `expires_at`, and a composite
`(company_id, document_type)` for the common "show me this company's
GST certificate" query Day 10 will need.

**Schema drift flagged**: `docs/05-database-schema.md` showed
`DocumentStatus` as four values (no `pending`). The code widened to
five to accommodate the two-step upload's pre-confirm state. The doc
should be updated to match — code wins per the project rules.

### R2 client layer in `lib/r2/`

- `lib/r2/client.ts` — `getPresignedPutUrl` and `getPresignedGetUrl`.
  Built on `aws4fetch@1.0.20` (sigv4 signer, ~6 KB, runtime-agnostic).
  Lazy singleton `AwsClient` so module-load doesn't try to instantiate
  with placeholder credentials. `signQuery: true` on both for
  browser-direct upload compatibility. 5-minute default URL expiry.
- `lib/r2/keys.ts` — pure helpers. `sanitizeFilename` strips slashes,
  quotes, control chars, collapses whitespace runs, strips leading
  dots (prevents Unix-hidden filenames), caps at 200 chars.
  `buildDocumentKey` composes the canonical `companies/{companyId}/
  {documentId}/{sanitizedFilename}` shape.
- `lib/env.ts` — four new env vars (`R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) with
  dev-only placeholder defaults so the app boots without R2 setup.
- `scripts/r2-smoke-test.ts` + `pnpm r2:smoke` — one-off round-trip
  verifier (PUT then GET, byte-for-byte check). Uses `cross-env` to
  apply `NODE_OPTIONS=--use-system-ca` automatically — see Gotchas
  below.

### Two Server Actions in `lib/documents/actions.ts`

| Action | Caller | Effect |
|---|---|---|
| `initiateDocumentUpload` | admin/staff for any company; company-role for own only | Validates, inserts `pending` row, mints presigned PUT URL, returns `{documentId, uploadUrl, mimeType, expiresInSeconds}` |
| `confirmDocumentUpload` | same authority gate | Validates, walks status (`pending` → `pending_review`, idempotent on already-pending_review, refuses verified/rejected), records `document_uploaded` audit event |

No audit event on initiate — only confirm is the durable event. A
client that aborts after initiate leaves a `pending` orphan that
Day 10's cleanup cron will sweep.

Cross-company attempts by company-role users return "Company not
found" rather than "forbidden", preventing ID enumeration — same
pattern as the companies/tenders modules.

### Pure RBAC predicate in `lib/documents/auth.ts`

`sessionCanAccessDocumentForCompany(session, companyId)` — pure
synchronous boolean predicate. Lives in its own file because Next.js
requires every export from a `"use server"` file to be async, and
this is pure-sync. Not yet wired into the action layer (which has its
own more detailed `requireUploadAuthority` with structured logging),
but parked ahead of Day 10's list / detail / download / verify /
reject / delete actions which will all route through it.

### Proof-of-concept upload UI

- **`app/dashboard/companies/[id]/documents/new/page.tsx`** — server
  component. Role-gates admin/staff for any company, company-role for
  own only (404 on cross-company). Fetches company by id for the page
  header. Mirrors the new-company page shape.
- **`components/documents/upload-form.tsx`** — client component. Owns
  the three-stage upload state machine:
  `idle → initiating → uploading → confirming → success`. Stage-
  specific button labels ("Preparing upload..." → "Uploading to
  storage..." → "Finalising..." → "Uploaded") so the user sees where
  they are. File picker enforces ALLOWED_MIME_TYPES + 10 MB cap
  pre-flight; the server re-validates via the same Zod schema. Errors
  at any stage retry-able without re-pick. Mirrors company-form
  patterns: inline Zod resolver, useTransition + `router.replace` on
  success, FormSection/FormField, StickyActionBar,
  useUnsavedChangesGuard.
- **Company detail header** — new `canUploadDocument` boolean prop on
  `company-header.tsx`, computed from session role + companyId per
  the RBAC matrix. Upload-document button sits between Back and Edit.
  Day 10's Documents tab will likely move this button into the
  section header.

### Test infrastructure

Vitest 4.1.7 + @vitest/ui added as devDeps (first use in this
codebase despite test references in earlier commit messages). New
`vitest.config.ts` at the repo root wires the `@/*` path alias and
uses the Node environment. `pnpm test` script added.

84 tests passing in ~520ms across three files:

- `lib/r2/keys.test.ts` (21 tests) — `sanitizeFilename` +
  `buildDocumentKey` coverage including path-traversal guards,
  control-char stripping, length cap, UTF-8 preservation.
- `lib/documents/__tests__/schemas.test.ts` (45 tests via `it.each`)
  — per-rule Zod coverage: happy path, missing/null optionals,
  oversize, bad MIME, malformed dates, cross-field
  `issuedOn <= expiresAt` ordering.
- `lib/documents/__tests__/actions.test.ts` (18 tests) — full RBAC
  matrix: admin / staff / company-owner / company-other; idempotency;
  status guards; audit-write verification.

R2 client and session reader are mocked via `vi.mock`. DB + audit log
+ schema run against the real local SQLite for genuine integration
coverage.

## Key decisions

**Two-step upload (initiate + confirm) over Worker-event watching.**
The alternatives were (a) stream uploads through a Worker that
records the row after the bytes land, or (b) use R2's event
notifications to a Worker that finalises the row asynchronously.
(a) hits the Workers 100 MB request-body limit and eats CPU + egress
unnecessarily for a feature where the client already has the bytes.
(b) needs a Worker and event subscription we don't have in Phase 1.
The two-step flow is the standard S3 pattern: client gets a presigned
URL, uploads directly, then tells the server "done." Worth a brief
delete sweep for orphan `pending` rows (Day 10 follow-up).

**`DocumentStatus` widened from four values to five.** The doc's
original `pending_review / verified / rejected / expired` set
assumes the row exists only after the upload succeeds. With the
two-step flow we need a state for "row exists, bytes not yet
confirmed" — that's `pending`, the new initial. Once `confirm` runs,
status flips to `pending_review` (which is what the doc considered
the initial state). Documenting the drift in the schema docstring;
Day 10 should update `docs/05-database-schema.md`.

**R2 key format encodes the document id, not a hash or a sequence.**
`companies/{companyId}/{documentId}/{sanitizedFilename}`. Three
reasons: (1) makes bucket-level lifecycle rules easy to scope to a
single company for offboarding; (2) preserves the original filename
in the key for human debuggability; (3) the `documentId` segment
prevents key collisions when two uploads share a filename. The
filename is sanitised but the original is also kept in the DB column
for download Content-Disposition.

**Upload UI at a dedicated page rather than a dialog.** A dialog
would have been faster but breaks down for the multi-file future and
for the eventual progress-bar treatment. A dedicated route is also
deep-linkable, which helps when staff are walking a company through
the flow over the phone.

**ActionResult duplication tolerated for now.** Each of
`lib/companies/actions.ts`, `lib/tenders/actions.ts`, and now
`lib/documents/actions.ts` re-declares the same
`ActionResult<T>` union locally. Centralisation to
`lib/types/action-result.ts` is the right cleanup but it's a separate
chunk that touches three modules. Tracked as Day 10+ tech debt;
flagged in the chunk 3 commit message.

**aws4fetch over AWS SDK v3.** aws4fetch is ~6 KB, zero
dependencies, and signs sigv4 against any S3-compatible endpoint —
exactly what we need. The AWS SDK v3 is ~2 MB and pulls a tree of
dependencies that aren't worth it for two presigning calls. The
trade-off is no fancy retry / streaming features, but we don't need
them.

**Sync sessionCan helper deleted from actions.ts, recreated in
auth.ts.** I originally exported a sync `sessionCanViewDocument-
ForCompany` from the bottom of `lib/documents/actions.ts`,
speculatively, for Day 10. Next.js 16 rejects this with "Server
Actions must be async" — every export from a `"use server"` file
must be awaitable. Moved the predicate to a new non-`"use server"`
file (`lib/documents/auth.ts`) and renamed it to
`sessionCanAccessDocumentForCompany`. The replacement also fixed an
edge case the original missed (returning true when both the session
and document companyId were null).

## Gotchas surfaced

**Node + Cloudflare R2 TLS renegotiation on Windows.** Smoke test
initially failed with `ssl3_read_bytes:ssl/tls alert handshake
failure`. R2's edge requests mid-handshake TLS renegotiation, which
Node's bundled undici fetch rejects by default on Windows. Fix:
`NODE_OPTIONS=--use-system-ca` (Node 22+, or
`--experimental-use-system-ca` for older versions). Baked into the
`pnpm r2:smoke` script via `cross-env` so contributors don't have to
remember the env-var dance. Dev-only — production on Cloudflare
Workers' runtime fetch handles renegotiation natively.

**Wrangler R2 commands default to local Miniflare.** `wrangler r2
bucket info consultway-docs` returned `object_count: 0` even after
a successful round-trip, because the command was querying the local
emulated bucket. Real R2 commands require `--remote`. Also note that
the bucket-stats backend lags the data plane by minutes — even with
`--remote`, the count can show stale.

**PASSWORD_PEPPER mismatch breaks every login silently.** Session
ended with login failures after Vitest mutated the dev SQLite.
Diagnosis: `.env.local` had the literal `replace-me-generate-with-
openssl` placeholder; the seeded admin row was hashed against the
dev fallback `dev-only-pepper-replace-in-prod` from `lib/env.ts`.
Setting the pepper to the dev-fallback value restored login without
re-seeding. **Long-term**: the env validator should warn when
`PASSWORD_PEPPER` still equals the example placeholder.

**Next.js "use server" files must export only async functions.**
Documented above. The compiler error is clear once you've seen it
once, but unhelpful if you assume "export" means "any export."
Captured in CLAUDE.md for Day 10 onwards.

**PowerShell `[id]` route segments need `-LiteralPath`.** Touched
again when dropping the Day 9 page into `app/dashboard/companies/
[id]/documents/new/`. The workaround is the same as Day 7's:
`Push-Location -LiteralPath <path>`, then plain `Copy-Item filename`,
then `Pop-Location`.

**Cloudflare R2 token permissions screen has three "Object"
options.** First token creation accidentally picked "Object Read
only" — uploads then failed with `403 AccessDenied` after the TLS
issue was resolved. The correct selection is "Object Read & Write"
(third radio button, not the fourth). Revoke and reissue if you
pick wrong; the credentials shown on token creation are the only
chance to copy them.

## Surfaces touched

```
lib/db/schema.ts                                       (modified)
drizzle/0006_elite_madame_web.sql                      (new, migration)
lib/env.ts                                             (modified)
.env.example                                           (modified)
lib/r2/client.ts                                       (new)
lib/r2/keys.ts                                         (new)
lib/r2/keys.test.ts                                    (new, 21 tests)
lib/documents/actions.ts                               (new)
lib/documents/schemas.ts                               (new)
lib/documents/auth.ts                                  (new)
lib/documents/__tests__/actions.test.ts                (new, 18 tests)
lib/documents/__tests__/schemas.test.ts                (new, 45 tests)
scripts/r2-smoke-test.ts                               (new)
vitest.config.ts                                       (new)
package.json                                           (modified)
pnpm-lock.yaml                                         (modified)
app/dashboard/companies/[id]/documents/new/page.tsx    (new)
components/documents/upload-form.tsx                   (new)
app/dashboard/companies/[id]/page.tsx                  (modified)
app/dashboard/companies/[id]/_components/company-header.tsx  (modified)
```

## Followups for Day 10+

1. **Company-detail Documents tab** — list with status badges,
   sortable by uploaded_at / expires_at, download via presigned GET,
   re-upload-to-replace flow for rejected docs.
2. **Verify / reject server actions** — admin/staff transitions
   pending_review → verified or → rejected with reviewer notes. Audit
   verbs (`document_verified`, `document_rejected`) already exist in
   `auditActionSchema` from Day 6's speculative add.
3. **Delete server action** — admin always, company-role on own
   pending/rejected only. Cascade R2 object delete.
4. **Expiry-reminder cron** — daily Worker that scans
   `documents WHERE expires_at <= today + 30 days AND status =
   'verified'` and sends Resend emails. Also flips status to
   `expired` for past-expiry docs.
5. **Pending-row cleanup cron** — daily Worker that deletes
   `documents WHERE status = 'pending' AND created_at < now - 1h`,
   sweeping abandoned upload-initiations.
6. **`docs/05-database-schema.md` update** — DocumentStatus widened
   from four to five values.
7. **Route Day 10 list/detail/download/verify/reject actions through
   `sessionCanAccessDocumentForCompany`** in `lib/documents/auth.ts`
   instead of re-deriving the predicate inline.
8. **`ActionResult<T>` centralisation** — move to
   `lib/types/action-result.ts`, refactor three modules to import.
9. **Env validator warning** — flag `PASSWORD_PEPPER`,
   `JWT_SECRET`, and R2 credential placeholders so future-Mayur
   doesn't lose another hour to silent auth failures.
10. **Content-Length-Range signing** — the presigned PUT URL today
    binds Content-Type only. A misbehaving client could upload bytes
    over the declared sizeBytes. Worth signing a
    `content-length-range` condition for hardening.
