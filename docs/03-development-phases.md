# 03 — Development Phases

The day-by-day implementation plan. Designed for **~21 calendar days** of
focused solo development, with daily commits and phase-end demos.

Each day has: a clear **goal**, a set of **deliverables**, an **acceptance
check**, and a **commit target**. Don't move to the next day until the acceptance
check passes — compounding shortcuts kill projects.

---

## Legend

- 🎯 **Goal** — one sentence description of what this day produces
- 📦 **Deliverables** — artifacts you should have at end of day
- ✅ **Acceptance** — how you verify it's done
- 🔖 **Commit** — the Conventional Commit you should land
- 🚨 **Blocker-risk** — if this day is shaky, pause and replan before continuing

---

# PHASE 0 — Foundation (Days 1–2)

> **Outcome:** Repo exists on GitHub, deploys a "Hello World" to Cloudflare,
> CI is green, design system is scaffolded, Payload + D1 + R2 are wired.

## Day 1 — Project bootstrap

🎯 Create the repo, install the stack, get a blank Next.js app running locally and deployed.

📦 Deliverables:
- GitHub repo created (private), README pushed
- Next.js 16 app scaffolded with TypeScript, Tailwind 4, ESLint, pnpm
- Local dev server runs on `http://localhost:3000`
- `wrangler.jsonc` configured with placeholder D1 + R2 bindings
- First deploy to Cloudflare Workers succeeds (shows default landing)
- `.env.example`, `.gitignore`, `.prettierrc`, `.editorconfig` committed
- `docs/` folder initialized with all `.md` files (copy from this template)

✅ Acceptance:
- `pnpm dev` → loads
- `pnpm build` → passes
- `pnpm deploy` → site is live at `<workers-subdomain>.workers.dev`

🔖 `chore: initialize project scaffold`

🚨 If deploy fails → fix this before Day 2. Deployment issues compound.

### Commands for Day 1

```bash
# 1. Scaffold
pnpm create next-app@latest consultway-ops \
  --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
cd consultway-ops

# 2. Install core deps
pnpm add \
  zod react-hook-form @hookform/resolvers \
  lucide-react class-variance-authority clsx tailwind-merge \
  framer-motion recharts pino

pnpm add -D \
  @types/node prettier prettier-plugin-tailwindcss \
  eslint-config-prettier eslint-plugin-prettier \
  husky lint-staged @commitlint/cli @commitlint/config-conventional

# 3. Cloudflare deploy adapter
pnpm add @opennextjs/cloudflare
pnpm add -D wrangler

# 4. Initialize shadcn/ui (writes to src/components/ui)
pnpm dlx shadcn@latest init

# 5. Git + Husky
git init
pnpm dlx husky init
echo "pnpm lint-staged" > .husky/pre-commit
```

### `wrangler.jsonc` skeleton (Day 1)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "consultway-ops",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "observability": { "enabled": true },
  "d1_databases": [
    // Filled in on Day 2
  ],
  "r2_buckets": [
    // Filled in on Day 2
  ]
}
```

---

## Day 2 — Database + Storage + CI

🎯 D1 and R2 are created, Drizzle schema scaffolded, Payload installed, CI runs.

📦 Deliverables:
- D1 databases created: `consultway-dev` (local) + `consultway-prod`
- R2 bucket created: `consultway-docs`
- `src/db/schema.ts` with a placeholder `users` table
- Drizzle migration runs locally and hits D1 successfully
- Payload 3.x installed and mounted at `/admin`
- `.github/workflows/ci.yml` runs on PR: lint + typecheck + build
- `.github/workflows/deploy.yml` runs on `main`: build + deploy
- First Payload admin user seeded via `pnpm db:seed`

✅ Acceptance:
- `wrangler d1 execute consultway-dev --local --command "SELECT 1"` returns 1
- `http://localhost:3000/admin` loads the Payload login screen
- PR to a throwaway branch shows green CI

🔖 `chore: wire up d1, r2, payload, and ci`

🚨 If Payload's D1 adapter throws on startup → fall back temporarily to
`@payloadcms/db-sqlite` pointed at a local file; file a follow-up issue. The
platform work doesn't depend on D1 adapter until Day 4.

### Commands for Day 2

```bash
# Payload
pnpm dlx create-payload-app@latest --template with-cloudflare-d1 --name .
# (Or add incrementally:)
pnpm add payload @payloadcms/next @payloadcms/db-d1-sqlite @payloadcms/richtext-lexical

# Drizzle
pnpm add drizzle-orm
pnpm add -D drizzle-kit

# Create the D1 DB
wrangler d1 create consultway-dev
# → copy the `database_id` into wrangler.jsonc

wrangler r2 bucket create consultway-docs
```

---

# PHASE 1 — Core Launchpad (Days 3–10)

> **Outcome:** Auth + RBAC work. Companies can self-register, upload documents,
> and see their own portal. Staff can see all companies in a roster and verify
> them. This is Proposal A deliverable.

## Day 3 — Auth foundation

🎯 Login, logout, and session management working for all 3 roles.

📦 Deliverables:
- Payload `Users` collection with `role: 'admin' | 'staff' | 'company-user'`
- Login page at `/login` (custom, not Payload admin's login)
- `middleware.ts` redirects unauthenticated users to `/login`
- `POST /api/auth/login` using Payload's auth API
- `POST /api/auth/logout` clears cookies
- Session read via `getCurrentUser()` helper in Server Components
- Role-aware redirect after login (admin → `/admin`, staff → `/dashboard`, company → `/dashboard`)
- Unit tests for `getCurrentUser()` and RBAC guards

✅ Acceptance:
- Can log in as seeded admin, see the dashboard shell, and log out
- Hitting `/dashboard` while logged out redirects to `/login`

🔖 `feat(auth): implement login, logout, and role-based session`

### Key file: `src/lib/auth/session.ts`

```ts
/**
 * Server-side session helper.
 * Reads the Payload JWT from cookies and returns the typed user or null.
 */
import { cookies } from 'next/headers';
import { getPayload } from 'payload';
import config from '@payload-config';
import { logger } from '@/lib/logger';
import type { User } from '@/payload-types';

export async function getCurrentUser(): Promise<User | null> {
  try {
    const payload = await getPayload({ config });
    const headers = new Headers();
    const cookieStore = await cookies();
    const token = cookieStore.get('payload-token')?.value;
    if (!token) return null;
    headers.set('cookie', `payload-token=${token}`);
    const { user } = await payload.auth({ headers });
    return (user as User) ?? null;
  } catch (err) {
    logger.warn({ err }, 'Failed to read session');
    return null;
  }
}

/** Throws if no user — use in Server Components that require auth. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    const { redirect } = await import('next/navigation');
    redirect('/login');
  }
  return user;
}

export async function requireRole(
  ...allowed: Array<User['role']>
): Promise<User> {
  const user = await requireUser();
  if (!allowed.includes(user.role)) {
    const { notFound } = await import('next/navigation');
    notFound();
  }
  return user;
}
```

---

## Day 4 — Design system + layout shell

🎯 Consultway's brand is applied. App shell (sidebar + topbar + content) renders.

📦 Deliverables:
- Tailwind theme updated with Consultway colors (from the Figma / logo): navy
  primary, accent, neutrals — see `07-design-system.md`
- shadcn components added: `button`, `input`, `card`, `dropdown-menu`,
  `avatar`, `sheet`, `table`, `dialog`, `form`, `toast`, `skeleton`, `tabs`, `badge`
- `src/components/layouts/AppShell.tsx` — sidebar + topbar + outlet
- Sidebar items vary by role (admin sees everything; company sees only their portal)
- Dark/light toggle (Tailwind `dark:` + `next-themes`)
- Logo renders in sidebar (from `public/logo.svg`)
- Responsive: sidebar collapses to hamburger on mobile

✅ Acceptance:
- Figma dashboard mock compared visually to the running app — spacing, colors, type match
- Lighthouse accessibility ≥ 90 on the shell

🔖 `feat(ui): design system, app shell, sidebar navigation`

---

## Day 5 — Company self-registration

🎯 A company can register itself through a multi-step form. Status starts as `pending`.

📦 Deliverables:
- Payload `Companies` collection with fields: legal name, CIN, GSTIN,
  registered address, sectors (infrastructure/solar/real-estate/etc), POC name,
  POC email, POC phone, status (`pending | active | suspended | rejected`)
- `/register` public page — multi-step form using React Hook Form + Zod:
  - Step 1: Company details (legal name, CIN, GSTIN)
  - Step 2: Primary contact (name, email, phone)
  - Step 3: Sectors of interest (multi-select checkboxes)
  - Step 4: Create password + T&C checkbox
- Server Action `registerCompanyAction` — creates the `User` (role `company-user`)
  AND the `Company` (linked), sets company status to `pending`
- Sends a welcome + verification email via Resend
- Duplicate-CIN check (CIN is unique) — graceful error UI
- E2E test: fill form → submit → see "registration received" screen

✅ Acceptance:
- A fresh company can register. Admin sees it in the roster with status `pending`.

🔖 `feat(companies): self-registration flow with multi-step form`

### Key validation: `src/lib/validations/company.ts`

```ts
import { z } from 'zod';

export const CIN_REGEX = /^[A-Z]{1}[0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const companyRegistrationSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  cin: z.string().regex(CIN_REGEX, 'Invalid CIN format'),
  gstin: z.string().regex(GSTIN_REGEX, 'Invalid GSTIN format').optional(),
  address: z.object({
    line1: z.string().min(3).max(200),
    line2: z.string().max(200).optional(),
    city: z.string().min(2).max(100),
    state: z.string().min(2).max(100),
    pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'Invalid pincode'),
  }),
  contact: z.object({
    fullName: z.string().min(2).max(100),
    email: z.string().email(),
    phone: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid phone'),
  }),
  sectors: z.array(z.enum([
    'infrastructure',
    'solar',
    'renewable-energy',
    'real-estate',
    'manufacturing',
    'other',
  ])).min(1, 'Pick at least one sector'),
  password: z.string().min(10).max(100),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms' }),
  }),
});

export type CompanyRegistrationInput = z.infer<typeof companyRegistrationSchema>;
```

---

## Day 6 — Email verification + password reset

🎯 Email verification works end-to-end. Forgot-password flow works.

📦 Deliverables:
- Resend wired: `src/lib/email/client.ts` + React Email templates
- Templates: `verification-email.tsx`, `password-reset.tsx`, `welcome.tsx`
- `/auth/verify?token=...` route handler verifies the email
- `/forgot-password` page → form → email with reset link
- `/reset-password?token=...` page → new password form
- All emails pass `react-email` preview check (screenshots stored in `docs/email-previews/`)

✅ Acceptance:
- Full loop: register → receive email → click link → verified → login → works
- Full loop: forgot password → receive email → click link → reset → login → works

🔖 `feat(auth): email verification and password reset via resend`

### `src/lib/email/client.ts`

```ts
/**
 * Thin wrapper around the Resend SDK.
 * All outbound transactional emails go through this module so we have a single
 * place to apply rate limits, add retries, and swap providers later.
 */
import { Resend } from 'resend';
import { logger } from '@/lib/logger';

const resend = new Resend(process.env.RESEND_API_KEY);

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  /** A rendered React Email component or HTML string. */
  html?: string;
  react?: React.ReactElement;
  /** Override the default reply-to for this send. */
  replyTo?: string;
}

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const from = process.env.EMAIL_FROM ?? 'Consultway <noreply@consultway.info>';
  const replyTo = args.replyTo ?? process.env.EMAIL_REPLY_TO;

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      react: args.react,
      replyTo,
    });
    if (error) throw error;
    logger.info({ id: data?.id, to: args.to, subject: args.subject }, 'Email sent');
  } catch (err) {
    logger.error({ err, to: args.to, subject: args.subject }, 'Email send failed');
    throw err;
  }
}
```

---

## Day 7 — Document upload (R2 presigned)

🎯 Company users can upload mandatory documents. Files go to R2.

📦 Deliverables:
- Payload `Documents` collection: `company` (relation), `type` (enum via CHECK),
  `fileKey` (R2 object key), `fileName`, `mimeType`, `sizeBytes`, `uploadedBy`,
  `uploadedAt`, `expiresAt`, `status` (`pending_review | verified | rejected`),
  `reviewedBy`, `reviewNotes`
- Document types: `gst_certificate`, `pan_card`, `incorporation_cert`,
  `board_resolution`, `cancelled_cheque`, `trade_license`, `other`
- `POST /api/uploads/presign` — returns presigned R2 PUT URL (5 min expiry)
- Client component `DocumentUpload` — drag/drop, multi-file, progress bar,
  validates mime-type + size (≤ 10 MB per file) client-side
- `POST /api/documents` — called after upload succeeds; creates the row
- Company dashboard page `/documents` — list, status pill, download/delete,
  "re-upload" flow for rejected docs

✅ Acceptance:
- Upload a 5 MB PDF → appears in R2 bucket → row in D1 → visible in UI
- Rejected upload (12 MB) → shown as client-side error, nothing written
- Deleting a doc removes both the D1 row and the R2 object

🔖 `feat(documents): r2 upload flow with presigned urls`

### Presign route handler: `src/app/api/uploads/presign/route.ts`

```ts
/**
 * POST /api/uploads/presign
 *
 * Generates a presigned PUT URL for R2.
 * Client uploads directly to R2 with this URL, bypassing the Worker body-size limit.
 */
import { NextResponse } from 'next/server';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireUser } from '@/lib/auth/session';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const bodySchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), // 10 MB
  documentType: z.enum([
    'gst_certificate', 'pan_card', 'incorporation_cert',
    'board_resolution', 'cancelled_cheque', 'trade_license', 'other',
  ]),
});

export async function POST(req: Request) {
  const user = await requireUser();
  const json = await req.json();
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { fileName, mimeType, sizeBytes, documentType } = parsed.data;

  // Scope uploads by company so we can apply bucket-level lifecycle rules later
  const companyId = user.companyId ?? user.id;
  const objectKey = `companies/${companyId}/${documentType}/${randomUUID()}-${fileName}`;

  const r2 = new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  });

  const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `${endpoint}/${process.env.R2_BUCKET_NAME}/${objectKey}`;

  const signed = await r2.sign(
    new Request(url, {
      method: 'PUT',
      headers: { 'content-type': mimeType, 'content-length': String(sizeBytes) },
    }),
    { aws: { signQuery: true } },
  );

  logger.info({ userId: user.id, objectKey, sizeBytes }, 'Presigned R2 URL');

  return NextResponse.json({
    uploadUrl: signed.url,
    objectKey,
    expiresInSeconds: 300,
  });
}
```

---

## Day 8 — Company roster + admin verification

🎯 Staff and admin see a searchable, filterable roster. They can verify companies and documents.

📦 Deliverables:
- `/companies` page (staff/admin) — data table with:
  - Columns: Company, CIN, Status, Documents (X of Y verified), Registered on, Actions
  - Filters: status, sector, search (by name/CIN)
  - Pagination (20/page)
- `/companies/[id]` detail page: profile, contacts, all docs, activity log
- Action: "Verify company" / "Reject with reason" / "Suspend"
- Action on each document: "Verify" / "Reject with reason"
- Email sent to company POC on status changes (uses Day 6 infra)
- Audit log table `company_activity` — who did what, when (Drizzle-managed)

✅ Acceptance:
- Staff verifies a company with 5 verified docs → status flips to `active`, email fires
- Company POC sees new status on next login

🔖 `feat(roster): searchable company directory with verification workflow`

### ⚠️ D1 gotcha — search

No full-text search out of the box. For Phase 1, use:

```sql
WHERE company.legal_name LIKE '%' || :search || '%'
   OR company.cin LIKE :search || '%'
```

If volume grows, add an FTS5 virtual table in Phase 3.

---

## Day 9 — Document expiry reminder cron

🎯 The system emails companies when documents are 30/14/7/1 days from expiry.

📦 Deliverables:
- Cloudflare Cron Trigger configured in `wrangler.jsonc` (runs daily at 06:00 IST = 00:30 UTC)
- Scheduled handler `src/workers/cron.ts` — queries for docs expiring in 30/14/7/1 days
- Reminder email template with doc name, expiry date, "re-upload" deep link
- Dedup: a `reminders_sent` table prevents sending the same reminder twice
- Integration test: manipulate `expiresAt` in test DB, run handler, inspect email queue

✅ Acceptance:
- Manual trigger: `wrangler dev --test-scheduled` → fires handler → emails visible in Resend dashboard

🔖 `feat(documents): cron-driven expiry reminders at T-30/14/7/1`

### `wrangler.jsonc` cron snippet

```jsonc
{
  "triggers": {
    "crons": ["30 0 * * *"]    // 00:30 UTC = 06:00 IST, daily
  }
}
```

---

## Day 10 — Phase 1 polish + demo

🎯 Rough edges smoothed. Seed data added. Phase 1 demo-ready.

📦 Deliverables:
- Empty-state illustrations on dashboard, companies list, documents list
- Skeleton loaders on all data tables
- Toast notifications (shadcn `sonner`) for all mutations
- 404 page + generic error boundary
- README "Demo credentials" block for the three roles
- Seed script creates: 1 admin, 2 staff, 3 companies (1 pending, 1 active, 1 suspended) with docs
- Loom video demo recorded (15 min) — walkthrough of the three role perspectives

✅ Acceptance:
- Share staging URL + credentials with client → they can explore without your help

🔖 `chore(phase-1): polish, seed data, and demo recording`

### 🎉 End of Phase 1 — Launchpad is live. Client can UAT while Phase 2 starts.

---

# PHASE 2 — Tenders & Notifications (Days 11–16)

> **Outcome:** Admins publish tenders with eligibility filters. Eligible
> companies see them and apply. Full email notification system.

## Day 11 — Tender data model + admin CRUD

🎯 Admin can create, edit, publish, and close tenders.

📦 Deliverables:
- Payload `Tenders` collection:
  - `title`, `slug`, `description` (rich text), `sectorTags[]`,
    `eligibilityRules` (JSON: min turnover, sectors, years of experience, etc),
    `documentsRequired[]`, `publishedAt`, `closesAt`, `status`
    (`draft | published | closed | archived`), `createdBy`
- `/tenders` admin view — list with status filter
- `/tenders/new` + `/tenders/[id]/edit` — full form with rich text editor
  (Payload's Lexical) and eligibility rule builder
- Checklist sub-field: repeatable list of required items
- Preview mode — admin sees what a company will see

✅ Acceptance:
- Admin creates a draft → publishes → status flips → `publishedAt` set
- Draft tenders are NOT visible to companies

🔖 `feat(tenders): admin crud with eligibility rules and checklists`

---

## Day 12 — Tender listing + eligibility filter

🎯 Companies see only tenders they're eligible for, or see all with "not eligible" badges.

📦 Deliverables:
- Eligibility evaluator `src/lib/tenders/eligibility.ts` — pure function that
  takes a `Company` + `Tender.eligibilityRules` and returns
  `{ eligible: boolean; reasons: string[] }`
- `/tenders` (company view) — cards/list with:
  - Eligible tenders first
  - "View details" → full description + eligibility breakdown
  - "Not eligible" with specific reason(s) shown
- Filters: sector, deadline, eligibility (toggle "hide ineligible")
- Unit tests for the eligibility evaluator (15+ cases)

✅ Acceptance:
- Company in "solar" sector sees solar tenders as eligible, infrastructure ones as ineligible with the exact rule that failed

🔖 `feat(tenders): company-facing listing with eligibility filtering`

---

## Day 13 — Tender applications

🎯 Companies apply to tenders. Admins review.

📦 Deliverables:
- Payload `TenderApplications`: `tender`, `company`, `submittedBy`, `status`
  (`submitted | shortlisted | rejected | awarded | withdrawn`), `coverLetter`,
  `attachments[]`, `submittedAt`, `decisionAt`, `decisionBy`, `decisionNotes`
- `/tenders/[id]/apply` — application form
  - Pre-fills from company profile
  - Upload additional docs (same R2 flow as Day 7)
- `/applications` for company — list of their own applications with status
- `/tenders/[id]/applications` for admin — all applications, actions to shortlist/reject/award
- Email on each status change to company POC

✅ Acceptance:
- Company applies, admin shortlists, company sees "Shortlisted" status + email

🔖 `feat(tenders): application submission and review workflow`

---

## Day 14 — Notification system

🎯 All notifications flow through a single queue. Users see in-app notifications.

📦 Deliverables:
- Drizzle-managed `notifications` table: `user_id`, `type`, `title`, `body`,
  `link`, `read_at`, `created_at`
- Notification creator: `createNotification({ userId, type, title, body, link })`
- Hook into: new registration (admin), status change (company), new tender
  published (eligible companies), application decision (company), doc reminder
- Top-bar bell icon with unread count, dropdown with latest 10
- `/notifications` page — full list
- Mark-as-read + mark-all-as-read actions

✅ Acceptance:
- Every email we send also creates an in-app notification
- Bell badge updates live (revalidate on mutation)

🔖 `feat(notifications): unified email + in-app notification system`

---

## Day 15 — Admin dashboard (Phase 2 scope)

🎯 Admin landing page shows platform health at a glance.

📦 Deliverables:
- `/dashboard` (admin view):
  - KPI cards: Total companies (by status), Active tenders, Open applications, Docs expiring < 30 days
  - Recent activity feed (last 20 events)
  - Chart: Monthly registrations (last 12 months) — Recharts
  - Chart: Tender pipeline (drafts / published / closed) — Recharts
  - Quick actions: "New tender", "Invite company", "Export roster"
- `/dashboard` (staff view): same minus admin-only quick actions
- `/dashboard` (company view): their docs + their applications + open tenders for them

✅ Acceptance:
- Dashboard renders in < 1s on a warm Worker
- All KPIs computed server-side with Drizzle queries (no over-fetching)

🔖 `feat(dashboard): role-aware admin and company dashboards`

---

## Day 16 — Phase 2 polish + demo

🎯 Phase 2 demo-ready.

📦 Deliverables:
- Export CSV for company roster + tender applications
- Full-roster search covers company, tender, application
- Accessibility audit: all forms keyboard-navigable, axe-core report clean
- Mobile responsiveness check on 375 / 768 / 1024 / 1440 px
- Phase 2 demo recording

🔖 `chore(phase-2): polish, csv export, and demo recording`

### 🎉 End of Phase 2 — Full Launchpad + Tender system is live.

---

# PHASE 3 — Operations Suite (Days 17–21)

> **Outcome:** Project tracking, transactions, and PDF reports. Full Proposal B scope.

## Day 17 — Projects data model + CRUD

🎯 Admin can create projects linked to a tender + company. Projects have milestones.

📦 Deliverables:
- Payload `Projects`: `name`, `code`, `company` (relation), `tender` (relation,
  optional), `startDate`, `targetEndDate`, `actualEndDate`, `status`
  (`planning | active | on-hold | completed | cancelled`), `sector`, `budget`
- Sub-collection `Milestones`: `project`, `title`, `targetDate`, `completedDate`,
  `status` (`pending | in-progress | completed | delayed`), `blockers`
- `/projects` list + `/projects/[id]` detail + `/projects/[id]/edit`
- Visual progress bar per project (completed milestones / total)

🔖 `feat(projects): project and milestone tracking`

---

## Day 18 — Project activity + audit trail

🎯 Every status change and milestone update is logged. Project timeline view.

📦 Deliverables:
- `project_activity` table (Drizzle) — auto-inserted via Payload hooks on
  `afterChange` for Projects + Milestones
- `/projects/[id]/timeline` — vertical timeline of all events
- File attachments per milestone (R2 flow)
- Comments on project (mentions trigger notifications)

🔖 `feat(projects): activity timeline and comments`

---

## Day 19 — Transactions (admin only)

🎯 Admin records financial transactions linked to projects/companies.

📦 Deliverables:
- Payload `Transactions` — **admin-only access** enforced at collection level:
  - `type` (`invoice | payment | expense | advance | refund`)
  - `amount` (INTEGER paise — avoid floats), `currency` (default INR)
  - `project` (relation), `company` (relation), `occurredOn`,
    `referenceNumber`, `notes`, `attachments[]`
- `/transactions` — filterable list (date range, type, project, company)
- Rollups per company + per project (sum by type)
- CSV export of transactions

✅ Acceptance:
- Staff role cannot see `/transactions` at all (middleware + UI both guard)
- Company role cannot see `/transactions`

🔖 `feat(transactions): admin-only financial ledger`

### ⚠️ Money handling

Always store as **INTEGER paise** (hundredths of rupees). Never use `REAL` /
`FLOAT` for money in SQLite — precision loss is a bug-class we refuse to own.

---

## Day 20 — PDF reports

🎯 One-click PDF export for company reports + monthly org reports.

📦 Deliverables:
- `/reports/companies/[id]` — generates a branded PDF via `pdf-lib` or a
  Worker-safe lib (`@cfworker/pdf`) — profile, docs status, projects,
  transactions summary
- `/reports/monthly` — org-wide monthly report (registrations, tenders,
  revenue) — PDF export
- PDFs are generated on-demand (not stored), streamed back to the client
- Branded cover page: logo, title, date range, Consultway address

✅ Acceptance:
- Download a company PDF, open it, all sections populated correctly
- PDF generation completes in < 3s on Workers

🔖 `feat(reports): branded pdf reports for companies and monthly ops`

### PDF approach

Worker CPU budget is tight. For larger PDFs, generate HTML, then use a headless
Chromium service (external) or **`@react-pdf/renderer`** which is pure JS and
works on Workers with `nodejs_compat`. Benchmark on Day 20.

---

## Day 21 — Final QA + production deploy

🎯 Production launch.

📦 Deliverables:
- Full regression pass (checklist — see `docs/12-testing.md`)
- Playwright E2E runs green
- Lighthouse ≥ 90 perf, ≥ 90 a11y, 100 SEO (login page only)
- Security pass: no secrets in repo, all routes guarded, rate limits on
  `/api/auth/*` (Cloudflare Rate Limiting rules)
- Production D1 migrated with `drizzle-kit push` + manual review
- Production R2 bucket lifecycle rules set (optional expiry on rejected docs)
- Custom domain `portal.consultway.info` pointed at Worker
- Sentry / Cloudflare Logs verified receiving errors
- Handover README with admin credentials, support contacts, runbook

🔖 `chore(phase-3): production launch checklist complete`

### 🎉 PROJECT COMPLETE.

---

## Sprint Velocity — What If Things Slip?

Realistic contingency:
- **+2 days** — R2 presigned URL edge cases (CORS, signature issues on Workers)
- **+1 day** — Payload D1 adapter quirks on deploy
- **+1 day** — PDF generation performance tuning
- **+1 day** — Accessibility audit fixes

If the critical path gets tight, **drop Phase 3** (Projects/Transactions/Reports)
and ship the Launchpad. This matches Proposal A and is independently deliverable.

Phase 1 + Phase 2 = complete operational platform minus project tracking.

---

## Daily Cadence Checklist

Every day, without exception:

- [ ] Pull `main`, branch `feat/day-XX-short-desc`
- [ ] Write the acceptance test FIRST when touching business logic
- [ ] Commit with Conventional Commit format
- [ ] `pnpm lint && pnpm typecheck && pnpm test` passes before push
- [ ] Open PR with screenshot/Loom for UI work
- [ ] Self-review the PR before marking ready
- [ ] Merge → verify staging deploy → cross the day off this document

---

## Definition of Done

A feature is "done" when:

1. ✅ Acceptance criteria for the day is met
2. ✅ Has TypeScript types (no `any`, no `@ts-ignore` without a comment)
3. ✅ Has error handling (try/catch + user-visible toast + logger.error)
4. ✅ Has loading state (skeleton or spinner)
5. ✅ Has empty state (friendly message + CTA when applicable)
6. ✅ Has at least one automated test
7. ✅ Is keyboard-accessible
8. ✅ Works on mobile (375px width minimum)
9. ✅ Is documented in code (JSDoc on public functions, why comments for non-obvious logic)
10. ✅ Is deployed to staging and verified manually
