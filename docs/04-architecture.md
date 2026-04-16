# 04 — Architecture

## High-Level System Diagram

```
                                  ┌─────────────────────┐
                                  │      Browser        │
                                  │  (React 19 client)  │
                                  └──────────┬──────────┘
                                             │ HTTPS
                                             ▼
                         ┌───────────────────────────────────────┐
                         │         Cloudflare Worker             │
                         │   (Next.js 16 via @opennextjs/cf)     │
                         │                                       │
                         │  ┌─────────────┐   ┌──────────────┐   │
                         │  │  App Router │   │  Middleware  │   │
                         │  │   (RSC +    │──▶│  (Auth gate) │   │
                         │  │  Server     │   └──────────────┘   │
                         │  │  Actions)   │                      │
                         │  └──────┬──────┘                      │
                         │         │                             │
                         │  ┌──────▼──────┐   ┌──────────────┐   │
                         │  │   Payload   │   │   Drizzle    │   │
                         │  │     CMS     │   │     ORM      │   │
                         │  │  (admin)    │   │              │   │
                         │  └──────┬──────┘   └───────┬──────┘   │
                         │         │                  │          │
                         │  ┌──────▼──────────────────▼──────┐   │
                         │  │        SQL (via binding)        │   │
                         │  └──────────────┬──────────────────┘   │
                         │                 │                      │
                         │  ┌──────────────▼──────────┐           │
                         │  │     Cron Scheduler      │           │
                         │  │   (daily reminders)     │           │
                         │  └─────────────────────────┘           │
                         └──────────┬──────────┬───────────┬──────┘
                                    │          │           │
                        ┌───────────▼──┐  ┌────▼──────┐  ┌─▼──────────┐
                        │ Cloudflare   │  │ Cloudflare│  │   Resend   │
                        │      D1      │  │    R2     │  │   (Email)  │
                        │  (SQLite)    │  │  (Files)  │  │            │
                        └──────────────┘  └───────────┘  └────────────┘
```

## Request Lifecycle — A User Uploads a Document

1. **Client** selects a file in `DocumentUpload` component.
2. **Client** calls `POST /api/uploads/presign` with file metadata.
3. **Worker**:
   - `middleware.ts` confirms session
   - Route handler validates file (mime, size) and checks RBAC
   - Signs an R2 PUT URL using `aws4fetch`
   - Returns `{ uploadUrl, objectKey }` to client
4. **Client** `PUT`s the file **directly to R2** using the presigned URL
   (bypasses Worker body limit).
5. **Client** calls `POST /api/documents` with `objectKey` + metadata.
6. **Worker**:
   - Verifies the R2 object actually exists (HEAD request)
   - Inserts row into `documents` table via Drizzle
   - Creates `notification` for admin (new doc to review)
   - Returns the document record
7. **Client** shows success toast, invalidates the list query, doc appears.

## Data Flow: Tender → Application → Decision

```
Admin creates Tender ──▶ draft ──▶ Admin clicks "Publish"
                                        │
                                        ▼
                    ┌─────────────────────────────────────┐
                    │  Payload afterChange hook:           │
                    │   - Finds eligible companies         │
                    │   - Creates notifications            │
                    │   - Queues emails via Resend         │
                    └─────────────────────────────────────┘
                                        │
                                        ▼
Company sees tender ──▶ Applies ──▶ TenderApplication created
                                        │
                                        ▼
                              Admin reviews ──▶ shortlists / rejects
                                        │
                                        ▼
                    ┌─────────────────────────────────────┐
                    │  Payload afterChange hook:           │
                    │   - Creates notification for company │
                    │   - Emails company POC               │
                    └─────────────────────────────────────┘
```

## Module Map

```
┌────────────── Frontend Feature Modules ─────────────┐
│                                                     │
│  Auth             Companies        Documents        │
│    login            register         upload         │
│    logout           roster           verify         │
│    verify           detail           expiry         │
│    reset            verify                          │
│                                                     │
│  Tenders          Applications    Notifications     │
│    create           submit          bell            │
│    publish          review          list            │
│    list             decide                          │
│    apply                                            │
│                                                     │
│  Dashboard        Projects        Transactions      │
│    (role-aware)     CRUD            ledger          │
│                     milestones      export          │
│                     timeline                        │
│                                                     │
│  Reports          Settings                          │
│    PDF              profile                         │
│    CSV              password                        │
│                     team (admin)                    │
└─────────────────────────────────────────────────────┘

┌────────────── Backend Services ─────────────────────┐
│                                                     │
│  Payload CMS        Drizzle ORM                     │
│    collections        schema                        │
│    hooks              queries                       │
│    access control     migrations                    │
│    auth                                             │
│                                                     │
│  Lib                                                │
│    auth/session       email/resend                  │
│    auth/rbac          email/templates               │
│    storage/r2         logger (pino)                 │
│    validations        tenders/eligibility           │
│    notifications                                    │
│                                                     │
│  Workers                                            │
│    cron (daily reminders)                           │
│    webhooks (future)                                │
└─────────────────────────────────────────────────────┘
```

## Authorization Model (RBAC)

Full matrix in [`08-rbac-matrix.md`](./08-rbac-matrix.md). Summary:

| Resource | Admin | Staff | Company |
|---|---|---|---|
| Users | CRUD | Read | Read self |
| Companies | CRUD | CRU | R self, U self |
| Documents | CRUD | CRU (verify) | CRU own |
| Tenders | CRUD, publish | CRU, publish | R published |
| TenderApplications | CRUD | CRU (decide) | CR own |
| Projects | CRUD | CRU | R own |
| Transactions | CRUD | ❌ | ❌ |
| Reports | Generate | Generate (no $) | Generate own |

Enforcement: **three layers** — middleware (route access), Payload `access`
functions (DB access), UI (conditional rendering). Never trust only one.

## Data Isolation

Companies must **never** see another company's data.

- All queries scoping company data include `WHERE company_id = :currentCompanyId`
- Enforced at the Payload `access.read` level:
  ```ts
  access: {
    read: ({ req: { user } }) => {
      if (!user) return false;
      if (user.role === 'admin' || user.role === 'staff') return true;
      return { company: { equals: user.company } };
    },
  }
  ```
- Automated test in Playwright: log in as company A, try to GET company B's
  doc by id → expect 404.

## Caching Strategy

- **Server Components** — default Next.js cache is off in Next 15+. We opt in
  per-query via `unstable_cache` for public/read-heavy data (published
  tenders list).
- **Client** — TanStack Query NOT used in Phase 1/2; we use Server Actions
  + `revalidatePath` / `revalidateTag`. Keeps surface area small.
- **Static assets** — served by Cloudflare Pages assets (long TTL + hashed filenames).
- **D1 read replicas** — enabled via Drizzle session binding (`first-primary`).

## Error Handling Philosophy

1. **Never swallow errors.** Every `catch` logs via `logger.error`.
2. **User-facing errors are generic.** We show "Something went wrong. Please
   try again" — details go to logs.
3. **Validation errors are specific.** Zod errors are returned to forms and
   rendered per-field.
4. **Server Actions return `{ ok, data, error }`**, never throw. Throwing
   renders the error boundary, which is jarring for a recoverable form
   submission error.

```ts
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
```

## Observability

- **Logs** — Pino to `console.log` → Cloudflare Workers Logs
- **Metrics** — Cloudflare Workers Analytics Engine (requests, errors, duration)
- **Error tracking** — Sentry for production (optional Phase 3+)
- **Uptime** — Cloudflare Health Checks on `/api/health`

## Health Check Endpoint

```ts
// src/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const db = getDb();
    await db.run('SELECT 1');
    return NextResponse.json({
      status: 'ok',
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', error: (err as Error).message },
      { status: 503 },
    );
  }
}
```
