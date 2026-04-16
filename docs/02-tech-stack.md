# 02 — Tech Stack

A detailed rationale for each choice, including tradeoffs considered and
alternatives rejected. This document is the "why" behind the stack — keep it
updated whenever a dependency is swapped.

## Guiding Principles

1. **Cloudflare-native** — the client is on a Cloudflare budget (~₹500–2,000/mo).
   Every choice must run on (or deploy to) Cloudflare's edge.
2. **TypeScript everywhere** — one language, one type system, shared schemas.
3. **Convention over configuration** — pick opinionated defaults that remove
   decisions (Payload, shadcn/ui, Drizzle).
4. **No vendor lock-in beyond Cloudflare** — all data is portable SQLite;
   auth is JWT; files are S3-compatible.
5. **Production-grade from day one** — lint, typecheck, test, CI, logging.

---

## Frontend

### Next.js 16 (App Router)

**Why:** The current stable as of April 2026. App Router is mature, Server
Components are stable, Server Actions replace a lot of boilerplate API routes,
and Turbopack is fast enough for daily dev.

**Key features we rely on:**
- Server Components for data-heavy pages (companies list, tenders list)
- Server Actions for mutations (form submissions, approvals)
- Route Handlers for third-party webhooks + file uploads
- Middleware for auth gating
- `generateMetadata` for SEO on public-ish pages (login splash)

**Tradeoffs:**
- Tied to React's Canary track — React 19.2 features used via App Router
- Heavier than Astro, but we need interactivity (dashboards, forms, realtime-ish UIs)

**Alternatives rejected:**
- **Remix/React Router v7** — great DX, but smaller ecosystem, Payload is Next-native
- **SvelteKit** — excellent perf, but team velocity is higher in React
- **Astro** — wrong tool for a dashboard (it's for content sites)

### React 19

**Why:** Shipped with Next 15+, now fully stable. We use:
- `useActionState` for server-action form state
- `useFormStatus` for pending UI
- `use()` for promise unwrapping in Client Components when needed
- Server Components for zero-JS-by-default data fetching

### TypeScript 5.6 (strict mode)

**Config highlights** (`tsconfig.json`):
```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "paths": { "@/*": ["./src/*"] }
  }
}
```

### TailwindCSS 4.0

**Why:** Utility-first, no runtime cost, composes well with shadcn/ui.
Tailwind 4 is the current major with the new Oxide engine (faster builds).

**Convention:** No arbitrary values inline in JSX unless unavoidable —
prefer design tokens defined in the theme.

### shadcn/ui

**Why:** Not an installed dependency — components are **copied into our repo**
(`src/components/ui/`). We own them, customize freely, no version lock-in.
Built on Radix UI primitives, so accessibility is free.

**Components we'll use:** `Button`, `Input`, `Dialog`, `DropdownMenu`, `Table`,
`Select`, `Toast`, `Form`, `Card`, `Badge`, `Avatar`, `Tabs`, `Sheet`, `Skeleton`.

### React Hook Form + Zod

**Why:**
- **React Hook Form** — uncontrolled-by-default, minimal re-renders, great DX
- **Zod** — schema validation that we can share between client (form) and server (action)

**Pattern:** Define the schema once in `src/lib/validations/`, import on both
sides of the wire.

```ts
// src/lib/validations/company.ts
export const registerCompanySchema = z.object({
  legalName: z.string().min(2).max(200),
  cin: z.string().regex(/^[A-Z0-9]{21}$/, 'Invalid CIN'),
  gstin: z.string().optional(),
  // ...
});

export type RegisterCompanyInput = z.infer<typeof registerCompanySchema>;
```

### Recharts

**Why:** React-first, composable, works with Server Components (render on server,
hydrate on client). We render dashboard charts (document status pie, tender
pipeline funnel, monthly registrations bar).

### Framer Motion

**Why:** Micro-interactions (sidebar collapse, modal enter, success confetti on
registration). Use sparingly — respect `prefers-reduced-motion`.

---

## Backend

### Next.js Route Handlers + Server Actions

**Split:**
- **Server Actions** — form submissions, mutations triggered from UI
- **Route Handlers** (`app/api/.../route.ts`) — webhooks (Resend, Cloudflare),
  file upload presigning, external integrations, anything called from outside
  the app

### Payload CMS 3.x

**Why:** Payload 3 is Next.js-native — it installs directly into our `app/`
directory and shares the same build. We get:
- A generated admin panel at `/admin` for free
- Type-safe collections (matches our Drizzle schema)
- Built-in auth with JWT + bcrypt
- Hooks (`beforeChange`, `afterChange`) for business logic
- Access control as first-class config
- Official D1 adapter (`@payloadcms/db-d1-sqlite`)

**Why not roll our own admin?** It would cost 3+ days of build time. Payload
gives us a polished admin for free, and we can theme it to match Consultway's
brand. The staff/company-facing dashboards are **custom-built** — we only use
Payload's admin for Consultway's internal super-admin use.

**Collections we'll define:**
- `Users` — all platform users (admin / staff / company-user)
- `Companies` — registered businesses
- `Documents` — uploaded files metadata + R2 keys
- `Tenders` — published opportunities
- `TenderApplications` — company applications to tenders
- `Projects` (Phase 3) — active engagements
- `Transactions` (Phase 3) — financial records

### Drizzle ORM

**Why:** SQLite-first, works on Cloudflare D1 without any shim. Schema is
TypeScript, migrations are generated SQL we can inspect and version.

**Pattern:** Drizzle defines the canonical schema; Payload's adapter reads
from the same D1 instance. For Payload-managed collections, Payload writes
the migrations. For our custom tables (audit logs, notifications queue),
Drizzle writes them.

### Auth: Payload + JWT + bcrypt

**Why:** Payload's built-in auth hashes with bcrypt (cost 10), issues JWTs,
and supports RBAC via `access` functions on collections. We extend it with:
- Custom `/api/auth/register` for company self-registration (outside admin)
- Custom middleware to gate `(app)/*` routes
- Password reset flow via Resend emails

### Resend (Email)

**Why:** Transactional email with a clean API, great deliverability, React
email templates, 3k free emails/month. Drop-in via their SDK.

**Emails we'll send:**
- Registration confirmation
- Email verification
- Password reset
- Document expiry reminders (T-30, T-14, T-7, T-1)
- Tender published (to eligible companies)
- Application status change
- Admin: new registration to approve

---

## Database & Storage

### Cloudflare D1 (SQLite)

**Strengths:** Free tier is generous, global read replicas, sub-ms reads at edge,
SQLite's battle-tested reliability.

**Gotchas we designed around:**
| Gotcha | Mitigation |
|---|---|
| No native enum type | Use `TEXT` + `CHECK(status IN ('draft','published','closed'))` |
| No full-text search by default | Use FTS5 virtual table (built-in) OR simple `LIKE '%term%'` for low-volume cases |
| No JSONB; only TEXT | Store JSON as TEXT, parse in app. Drizzle has a `json` helper that does this automatically |
| No `RETURNING *` on older D1 (now supported as of 2024) | Works now, but always test |
| Max row size ~1 MB; max DB size 10 GB | Store documents in R2, not D1 |
| No `pg_trgm` / fuzzy search | Filter by prefix (`LIKE 'term%'`) or pre-compute search tokens |
| Transactions work but are session-scoped | Use Drizzle's `.batch()` or D1's `batch()` for atomicity across statements |
| Date/time are TEXT ISO strings (no native Date type) | Drizzle's `text({ mode: 'string' })` + convert in app; or store as INTEGER unix timestamp |

### Cloudflare R2

**Why:** S3-compatible, **zero egress fees**, bound directly to our Worker.

**Upload pattern:** Client requests a presigned URL → uploads directly to R2
→ notifies our API with the R2 key → we insert a `Documents` row. This
bypasses the Worker's 100 MB request body limit.

---

## Infrastructure

### Cloudflare Workers via `@opennextjs/cloudflare`

**Why:** The OpenNext Cloudflare adapter supports the full Next.js feature set
(App Router, Server Actions, middleware, image optimization) on Workers with
Node.js compatibility mode. It's the recommended path for Next 14+/15+/16+ on
Cloudflare.

**Config:** `open-next.config.ts` + `wrangler.jsonc` with `nodejs_compat` flag.

### GitHub Actions CI/CD

**Pipelines:**
- `ci.yml` on every PR: lint + typecheck + test
- `deploy.yml` on push to `main`: build + migrate D1 + `wrangler deploy`

### Logging: Pino

**Why:** Structured JSON logs, edge-compatible (no Node-only deps), fast.
Workers console shows these natively.

```ts
// src/lib/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'consultway-ops' },
  // In Workers, default transport is fine — Cloudflare ingests stdout JSON
});
```

### Validation: Zod (again)

Same library front and back. Shared schemas live in `src/lib/validations/`.

---

## Testing

| Layer | Tool | Scope |
|---|---|---|
| Unit | **Vitest** | Utils, validators, formatters, queries |
| Component | **React Testing Library + Vitest** | UI components in isolation |
| E2E | **Playwright** | Critical flows: register → login → upload → apply to tender |
| Load (optional) | **k6** | Pre-launch check on tender listing page |

---

## Developer Experience

| Tool | Purpose |
|---|---|
| **pnpm** | Fast, disk-efficient package manager |
| **Husky + lint-staged** | Pre-commit lint/format |
| **Commitlint** | Enforce Conventional Commits |
| **ESLint 9** (flat config) | Linting |
| **Prettier** | Formatting |
| **Drizzle Studio** | Visual DB browser during dev |

---

## Summary Table

| Concern | Choice | Version target |
|---|---|---|
| Framework | Next.js | 16.2.x |
| Runtime | React | 19.x |
| Language | TypeScript | 5.6.x (strict) |
| Styling | TailwindCSS | 4.0.x |
| Components | shadcn/ui + Radix | latest |
| Forms | React Hook Form + Zod | latest |
| CMS/Admin | Payload CMS | 3.x |
| ORM | Drizzle | latest |
| DB | Cloudflare D1 | n/a (managed) |
| Files | Cloudflare R2 | n/a (managed) |
| Host | Cloudflare Workers (OpenNext) | `@opennextjs/cloudflare` latest |
| Email | Resend | latest SDK |
| Logging | Pino | latest |
| Testing | Vitest + Playwright | latest |
| Package mgr | pnpm | 9.x |
