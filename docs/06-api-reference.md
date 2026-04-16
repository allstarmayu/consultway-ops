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

### `GET /api/notifications?unread=true&limit=10`
### `POST /api/notifications/:id/read`
### `POST /api/notifications/read-all`

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
