# 06 — API Reference

This project uses a **hybrid API style**:

- **Server Actions** for UI-driven mutations (forms, approvals) — called
  directly from React components, no REST boilerplate.
- **Route Handlers** (`app/api/.../route.ts`) for anything else: external
  integrations, webhooks, file upload presigning, polling endpoints.

All routes assume JSON request/response unless stated. All responses follow:

```json
// Success
{ "data": { ... } }

// Error
{ "error": "human readable", "fieldErrors": { "fieldName": ["..."] } }
```

Status codes: `200` OK, `201` Created, `400` validation, `401` unauth,
`403` forbidden, `404` missing, `409` conflict, `422` business rule, `500` server.

---

## Auth

### `POST /api/auth/login`

Public. Takes credentials, issues a `payload-token` HTTP-only cookie.

Body:
```json
{ "email": "admin@consultway.info", "password": "..." }
```

Response 200:
```json
{ "data": { "user": { "id": "...", "email": "...", "role": "admin" } } }
```

Rate-limited: 5 attempts / 15 min / IP via Cloudflare Rate Limiting rules.

### `POST /api/auth/logout`

Auth required. Clears the cookie.

### `POST /api/auth/register`

Public. Creates a `company-user` + `pending` `Company`.

Body: see `companyRegistrationSchema` in `src/lib/validations/company.ts`.

Side effects:
- Sends verification email via Resend
- Creates `notification` for all admins: "New company awaiting approval"

### `GET /api/auth/verify?token=...`

Public. Validates the email verification token and flips `email_verified_at`.

### `POST /api/auth/forgot-password`

Body: `{ "email": "..." }`. Always returns 200 (do not leak whether email exists).

### `POST /api/auth/reset-password`

Body: `{ "token": "...", "newPassword": "..." }`

### `GET /api/auth/me`

Auth required. Returns the current user + their company (if any).

---

## Companies

### Server Action: `registerCompanyAction(input)`

Used by the public `/register` form. Wraps `POST /api/auth/register`.

### Server Action: `updateCompanyAction(companyId, patch)`

- Admin/Staff: can update any company
- Company user: can only update their own company (enforced by Payload access)

### Server Action: `verifyCompanyAction(companyId)`

Admin/Staff only. Preconditions:
- All mandatory documents are `verified`
- Company status is `pending`

Side effects:
- Sets `status = 'active'`, `verified_at`, `verified_by`
- Emails POC
- Creates in-app notification

### Server Action: `rejectCompanyAction(companyId, reason)`

Admin only. Sets `status = 'rejected'` + `rejection_reason`. Emails POC.

### `GET /api/companies?search=&status=&sector=&page=&limit=`

Auth required. RBAC-aware:
- Admin/Staff: sees all
- Company user: sees only their own (response is always a 1-item list)

Query params:
- `search` — matches `legal_name` (LIKE) and `cin` (prefix)
- `status` — filter by status enum
- `sector` — joins `company_sectors`
- `page` — default 1
- `limit` — default 20, max 100

Response 200:
```json
{
  "data": {
    "items": [{ "id": "...", "legalName": "...", "status": "...", ... }],
    "page": 1,
    "limit": 20,
    "total": 142,
    "totalPages": 8
  }
}
```

### `GET /api/companies/:id`

Auth required. RBAC enforced at Payload access level.

### `GET /api/companies/export.csv`

Admin/Staff only. Streams CSV of all companies matching current filters.

---

## Profile (Day 28 + Day 29)

User-facing actions for the Settings → Profile section. All actions
require an authenticated session; each callable is restricted to the
signed-in user's own row (the actions don't accept a `userId` parameter
— they read `readSession()`).

> Drift note: pre-Day-28 the only persistent profile field was `name`.
> Days 28 + 29 brought `phone`, `job_title`, and `avatar_key` online.
> Email change is still deferred (needs a verify-old + verify-new flow,
> queued for a security-themed session).

### Server Action: `updateProfile(input)` (Day 28)

Source: `lib/profile/actions.ts`. Updates the signed-in user's display
name, phone, and/or job title in a single call.

Input (Zod, `.strict()`):
```ts
{
  name: string;                  // 2-120 chars, trimmed
  phone?: string | null;         // ≤ 32 chars trimmed, or null to clear
  jobTitle?: string | null;      // ≤ 120 chars trimmed, or null to clear
}
```

Empty string on `phone` / `jobTitle` is coerced to `null` server-side,
so the form's "user cleared the input" gesture round-trips cleanly to
a NULL column.

Behaviour:
- Stale-session guard via `assertUserExists` from `lib/auth/session.ts`.
- Per-field diff: only columns that ACTUALLY change get written, and
  the audit `before` / `after` snapshots carry only those columns. A
  save with no changes is a no-op (no write, no audit row).
- Audit event `updated` on `target_type = 'user'`, scoped to the diff.

Response: `{ ok: true, name, phone, jobTitle }` on success or
`{ ok: false, error, field? }` on validation / auth failure.

### Server Action: `initiateAvatarUpload(input)` (Day 29)

Source: `lib/avatars/actions.ts`. Step 1 of the two-step avatar upload
flow. Mints a presigned R2 PUT URL the client uses to upload bytes
directly. The DB is NOT written at this step — orphaned `initiate`
calls (client gives up before the upload completes) leave no row to
clean up.

Input:
```ts
{
  fileName: string;              // raw filename for sanitisation
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;             // ≤ 5_242_880 (5 MB)
}
```

Response 200:
```json
{
  "ok": true,
  "uploadUrl": "https://...r2.cloudflarestorage.com/...?X-Amz-Signature=...",
  "avatarKey": "avatars/<userId>/<sanitisedFilename>",
  "expiresInSeconds": 300
}
```

The client MUST send `Content-Type: <mimeType>` on the PUT — sigv4
binds the content-type and R2 rejects mismatches.

### Server Action: `confirmAvatarUpload(input)` (Day 29)

Step 2 of the avatar upload flow. Called after a successful R2 PUT.
Writes `users.avatar_key` for the signed-in user, deletes the previous
R2 object if one existed (replace semantics), and emits an audit event.

Input:
```ts
{
  avatarKey: string;             // exact value returned by initiate
}
```

Behaviour:
- Validates the avatar key starts with `avatars/{signedInUserId}/` so
  a client can't trick the action into pointing a different user's row
  at someone else's blob.
- On replace, the old R2 object is best-effort deleted (failure logs
  + leaks the old blob, doesn't block the update — same pattern as
  documents).

### Server Action: `deleteAvatar()` (Day 29)

Clears `users.avatar_key` and best-effort deletes the R2 object. The
Avatar component falls back to initials when the column is NULL.

### Display URL (server-side helper, not a Server Action)

`lib/avatars/server.ts::getAvatarDisplayUrl(avatarKey)` — used by
Server Components (e.g. `app/dashboard/settings/page.tsx`) to mint a
short-lived presigned GET URL. Returns null for null input or sign
failure — never throws. Same shape and rationale as
`lib/preferences/server.ts::getPreferencesForSSR`.

---

## Users (Day 33–34)

In-app user management for the `/dashboard/admin/users` module. Two access
tiers, gated by the shared role helpers in `lib/auth/guards.ts` (route +
action enforce, defence in depth):

- **Admin** — full access to every action and every role.
- **Staff** (`requireAdminOrStaff`) — the **company-account onboarding**
  tier: `listUsers`, `getUser`, `createUser`, and `resendInvite`, scoped to
  **company-role** users only (internal admin/staff accounts are hidden as
  not-found, and `createUser` refuses any non-company role). The management
  lifecycle — `updateUser`, `deactivateUser` / `reactivateUser`,
  `resetUserPassword` — stays `requireAdmin()`. Company-role callers get
  `{ ok: false }` everywhere.

Source: `lib/users/actions.ts`, schemas in `lib/users/schemas.ts`.

> Note: soft-delete is the `is_active` boolean (not a `status` enum — see
> `lib/db/schema.ts`); code wins over any older schema/matrix prose.

Onboarding is **invite-based**: admins never set a password. `createUser`
mints an invite token (a longer-lived `password_reset_tokens` row — see
`lib/auth/tokens.ts::mintInviteToken`) and emails a set-password link; the
invitee chooses their own credential via `acceptInvite`. All mutations
audit on `target_type = 'user'` (`created` / `updated` + `metadata.action`).

### Server Action: `listUsers(query)`

`requireAdminOrStaff`. Filter + search + sort + paginate. Left-joins the
linked company name and **strips `password_hash`** from every row. **For a
staff caller the result is forced to company-role users** (any `role` filter
in the query is ignored).

Query (Zod, coerced from URL search params):
```ts
{
  role?: "admin" | "staff" | "company";
  status?: "active" | "inactive";   // maps to is_active (string enum, NOT a
                                     // coerced boolean — z.coerce.boolean("false")
                                     // is truthy)
  companyId?: string;               // uuid
  search?: string;                  // LIKE over name + email
  page?: number;                    // default 1
  perPage?: number;                 // default 20, max 100
  sortBy?: "name" | "email" | "role" | "createdAt" | "lastLoginAt" | "updatedAt";
  sortDir?: "asc" | "desc";         // default desc
}
```
Response: `{ ok: true, rows: UserWithCompany[], total, page, perPage }`.

### Server Action: `getUser(id)`

`requireAdminOrStaff`. Single user by id (password hash stripped, company
name joined). Returns `{ ok: false }` for unknown ids so the detail page can
`notFound()` — and **for a staff caller, internal admin/staff rows return
the same not-found** (company-role users only).

### Server Action: `createUser(input)` (invite)

`requireAdminOrStaff` — **a staff caller may only invite `role: "company"`
users** (a non-company role returns `{ ok: false, field: "role" }`). Creates
the row with an **unusable random placeholder hash** (so the
account can't be logged into until accepted), `is_active = true`,
`email_verified_at = NULL`, then mints an invite + sends the set-password
email (fail-soft).

Input:
```ts
{
  email: string;                    // lowercased, unique
  name: string;                     // 2-200 chars
  role: "admin" | "staff" | "company";
  companyId?: string | null;        // REQUIRED for company role; forbidden for admin/staff
  phone?: string | null;
  jobTitle?: string | null;
}
```
Response: `{ ok: true, id, inviteEmailSent }` — `inviteEmailSent` mirrors
the registration flow so the UI can surface a "resend invite" affordance
when the mail couldn't go out. (Tests call `createUserInternal(input, { sendEmail })`.)

### Server Action: `updateUser(input)`

`requireAdmin`. Patch-style; every field optional except `id`. **`email` and `isActive`
are intentionally NOT editable here** — email change needs re-verification
(separate flow), and active-state is toggled by the dedicated
deactivate/reactivate actions.

Guards:
- **Self-lockout**: an admin can't change their own role away from admin.
- **Last-admin**: can't demote the final active admin.
- **Role ↔ company invariant** re-checked against merged state — moving to
  admin/staff clears `company_id`; moving to company requires one. The
  company-existence check only fires when the patch actually moves
  role/company (a pure profile edit of a user whose company was deleted
  isn't blocked).

### Server Action: `deactivateUser(id)` / `reactivateUser(id)`

`requireAdmin`. Soft-disable / re-enable via `is_active`. A disabled user is refused at
login. Can't deactivate yourself; **can't deactivate the final active
admin**. Idempotent (no-op + no audit when already in the target state).

> Note: sessions are stateless 7-day JWTs, so deactivation/role-change
> takes effect at next sign-in, not instantly — a live session persists
> until its JWT expires. Full revocation (`sessionVersion` /
> `passwordChangedAt`) is a queued hardening item.

### Server Action: `resetUserPassword(id)`

`requireAdmin`. Admin-triggered: mints a 1-hour reset token and emails a `/reset-password`
link. Refuses **not-yet-accepted** users (steers to Resend invite — a
reset would void the invite token without verifying them) and
**deactivated** users. Audits `metadata.action = "password_reset_requested",
via: "admin"`. (`resetUserPasswordInternal(id, { sendEmail })` for tests.)

### Server Action: `resendInvite(id)`

`requireAdminOrStaff` (staff: company-role targets only — others return
not-found). Re-sends the set-password invite. Valid only while the account
is unaccepted (`email_verified_at` NULL) and active; refuses already-
activated or deactivated users. Audits `metadata.action = "invite_resent"`.

### Server Action: `acceptInvite(input)`

**Public** (the invitee isn't signed in). Backs the `/set-password` page.
Consumes the invite token, writes the chosen password, and **flips
`email_verified_at`** (clicking a link sent to the address proves
ownership). Reuses `resetPasswordSchema` (`{ token, newPassword }`).
Source: `lib/auth/actions.ts`.

Response: `{ ok: true }`, or `{ ok: false, error, field }` with distinct
copy for invalid / expired / already-used links.

---

## Documents

### `POST /api/uploads/presign`

Auth required. Returns a presigned R2 PUT URL for a single file.

Body:
```json
{
  "fileName": "gst-cert.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 482193,
  "documentType": "gst_certificate"
}
```

Response 200:
```json
{
  "data": {
    "uploadUrl": "https://...r2.cloudflarestorage.com/...?X-Amz-Signature=...",
    "objectKey": "companies/<id>/gst_certificate/<uuid>-gst-cert.pdf",
    "expiresInSeconds": 300
  }
}
```

### `POST /api/documents`

Auth required. Called **after** a successful R2 PUT, to record metadata.

Body:
```json
{
  "companyId": "...",
  "documentType": "gst_certificate",
  "objectKey": "companies/.../...",
  "fileName": "gst-cert.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 482193,
  "issuedOn": "2025-04-01",
  "expiresAt": "2026-03-31"
}
```

Side effects:
- Verifies the R2 object exists (HEAD)
- Inserts `documents` row (status `pending_review`)
- Creates notification for admins/staff

### Server Action: `verifyDocumentAction(documentId)`

Admin/Staff only. Sets status to `verified`. Emails POC.

### Server Action: `rejectDocumentAction(documentId, reason)`

Admin/Staff only. Sets status to `rejected` with `review_notes`. Emails POC.

### `DELETE /api/documents/:id`

- Company user: can delete own docs if status is `pending_review` or `rejected`
- Admin: can delete any doc

Side effects: deletes the R2 object asynchronously.

### `GET /api/documents/:id/download`

Auth required. Returns a short-lived presigned GET URL for the R2 object.

Response 200:
```json
{ "data": { "url": "https://...", "expiresInSeconds": 300 } }
```

---

## Tenders

### `GET /api/tenders?status=&sector=&eligibility=`

- Admin/Staff: sees all (including drafts they created)
- Company user: sees only `published` tenders; `eligibility=eligible` filters further

### `GET /api/tenders/:id`

Auth required. Response includes computed `eligibility` block for company users:
```json
{
  "data": {
    "tender": { ... },
    "eligibility": {
      "eligible": false,
      "reasons": ["Your company's turnover is below the minimum ₹5 Cr requirement"]
    }
  }
}
```

### Server Action: `createTenderAction(input)`

Admin/Staff only. Creates a `draft` tender.

### Server Action: `publishTenderAction(tenderId)`

Admin/Staff only. Sets `status = 'published'`, `published_at = now()`.

Side effects:
- For each eligible company, creates notification + emails POC

### Server Action: `closeTenderAction(tenderId)`

Admin/Staff only. Sets `status = 'closed'`.

### Server Action: `archiveTenderAction(tenderId)`

Admin only.

---

## Tender Applications

### Server Action: `submitApplicationAction(tenderId, input)`

Company user only. Preconditions:
- Tender is `published` and not past `closes_at`
- Company is eligible
- Company has not already applied (UNIQUE constraint)

### Server Action: `decideApplicationAction(applicationId, decision, notes?)`

Admin/Staff only. `decision ∈ { shortlisted, rejected, awarded }`.

Side effects: notification + email to company POC.

### Server Action: `withdrawApplicationAction(applicationId)`

Company user only. Only allowed while status is `submitted`.

### `GET /api/applications?tenderId=&companyId=&status=`

RBAC-aware (company users only see their own).

---

## Projects (Phase 3)

### `GET /api/projects?status=&companyId=`
### `GET /api/projects/:id`
### Server Action: `createProjectAction(input)`
### Server Action: `updateProjectAction(projectId, patch)`
### Server Action: `updateMilestoneAction(milestoneId, patch)`

---

## Transactions (Phase 3 — Admin only)

### `GET /api/transactions?type=&from=&to=&companyId=&projectId=`
### Server Action: `createTransactionAction(input)`
### Server Action: `updateTransactionAction(id, patch)`
### `GET /api/transactions/export.csv`

---

## Reports (Phase 3)

### `GET /api/reports/company/:id.pdf`

Streams a branded PDF.

### `GET /api/reports/monthly?year=&month=.pdf`

Admin/Staff only. Streams org-wide PDF.

---

## Notifications

In-app notification feed. Source: `lib/notifications/`. Every read/write is
scoped to the **calling user** — a notification has exactly one recipient, and
the RBAC matrix (§ Notifications) grants each role "own notifications" only (no
admin/staff override). The sidebar bell badge + the `/dashboard/notifications`
page consume these.

Created **programmatically**, never via a user-facing action: domain actions
call `createNotification` / `createNotificationsForUsers` (`lib/notifications/
notify.ts`) at the same site they send the email / record the audit event.
Both are fail-soft (mirror `recordAuditEvent` — never throw; a missed
notification must not break the triggering action).

Event sources (every declared `NotificationType` is raised by exactly one
event — the union has no unwired members):

| Type | Raised by | Recipients |
|---|---|---|
| `company_verified` / `company_rejected` / `company_suspended` | `transitionComplianceStatus` | the company's users |
| `company_registered` | `registerCompanyInternal` (public self-registration) | active admins |
| `application_shortlisted` / `application_rejected` | `updateApplicationStatusInternal` | the applicant company's users |
| `application_awarded` | `markAwarded` | the awarded company's users |
| `tender_published` | `transitionTenderStatus` (draft → published only) | eligible compliant companies' users |
| `document_expiring` | the expiry-sweep cron (`runExpirySweep`) | the company's users — shares the email's `reminders_sent` dedup |

There is no `user_invited` notification: an invited user can't sign in to see
an in-app entry until they accept, by which point it's stale; the invite email
carries that touch instead.

### Server Action: `listNotifications(query)`

`readSession` (any signed-in user), scoped to the caller. Newest-first,
paginated. Query (Zod, coerced from URL params):
`{ page?, perPage? (≤100), filter?: "all" | "unread" }`. Response:
`{ ok: true, rows, total, page, perPage }`.

### Server Action: `unreadNotificationCount()`

The caller's unread count — backs the sidebar bell badge.
Response: `{ ok: true, count }`.

### Server Action: `markNotificationRead(id)`

Stamps `read_at` on one of the caller's notifications. Scoped by `user_id` in
the WHERE (a caller can't flip another user's row) + a `read_at IS NULL` guard
(idempotent). Response: `{ ok: true }`.

### Server Action: `markAllNotificationsRead()`

Stamps `read_at` on all the caller's unread notifications.
Response: `{ ok: true }`.

---

## Webhooks (future)

### `POST /api/webhooks/resend`

Resend delivery/bounce events. Validates `Svix-Signature` header.

---

## Cron

### Internal: `scheduled` Worker handler

Defined in `src/workers/cron.ts`. Runs daily. See Day 9 in
[`03-development-phases.md`](./03-development-phases.md).

---

## Health

### `GET /api/health`

Public. Returns `{ status: 'ok' | 'error', time }`. Used by Cloudflare Health Checks.

---

## Error Codes Reference

| Code | When |
|---|---|
| `AUTH_REQUIRED` | No valid session |
| `FORBIDDEN` | Authenticated but RBAC blocks |
| `NOT_FOUND` | Resource doesn't exist OR is outside user's scope |
| `VALIDATION_FAILED` | Zod validation failed; see `fieldErrors` |
| `DUPLICATE` | UNIQUE constraint violation (e.g. CIN already registered) |
| `PRECONDITION_FAILED` | Business rule blocked the action (e.g. applying to a closed tender) |
| `RATE_LIMITED` | Too many requests |
| `INTERNAL_ERROR` | Server error; details in logs |

---

## Rate Limits

Configured at the Cloudflare edge (dashboard rules), not in app code:

| Endpoint | Limit |
|---|---|
| `/api/auth/login` | 5 / 15 min / IP |
| `/api/auth/register` | 3 / hour / IP |
| `/api/auth/forgot-password` | 3 / hour / IP |
| `/api/uploads/presign` | 60 / hour / user |

---

## OpenAPI (optional, post-launch)

We don't auto-generate OpenAPI in v1 — the API surface is internal. If we
ever expose public APIs, we'll add `zod-to-openapi` and serve `/api/openapi.json`.
