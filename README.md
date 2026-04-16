# Consultway Infotech — Operations & Project Management Platform

> Internal web platform that digitizes Consultway Infotech's operations —
> replacing Excel sheets, WhatsApp, email, and phone-based coordination with a
> unified digital system for company onboarding, tender management, project
> tracking, transactions, and reporting.

[![Next.js](https://img.shields.io/badge/Next.js-16.2-black?logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Payload CMS](https://img.shields.io/badge/Payload-3.x-000000)](https://payloadcms.com)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020?logo=cloudflare)](https://developers.cloudflare.com)
[![TailwindCSS](https://img.shields.io/badge/Tailwind-4.0-06B6D4?logo=tailwindcss)](https://tailwindcss.com)

---

## 📋 Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Quick Start](#quick-start)
5. [Development Phases](#development-phases)
6. [Documentation](#documentation)
7. [Environment Variables](#environment-variables)
8. [Scripts](#scripts)
9. [Deployment](#deployment)
10. [Contributing](#contributing)

---

## Project Overview

Consultway Infotech is a project management consultancy helping private sector
companies in India access government-backed infrastructure and solar projects.
This platform is their **internal operations portal** (distinct from the public
marketing site at `consultway.info`).

### Core Modules

| Module | Audience | Status |
|---|---|---|
| **Authentication & RBAC** | All roles | Phase 1 |
| **Company Self-Registration** | Companies | Phase 1 |
| **Document Management** | Companies + Staff | Phase 1 |
| **Company Roster** | Staff + Admin | Phase 1 |
| **Tender Management** | All roles | Phase 2 |
| **Email Notifications** | System | Phase 2 |
| **Admin Dashboard** | Admin + Staff | Phase 2 |
| **Project Tracking** | All roles | Phase 3 |
| **Transactions** | Admin only | Phase 3 |
| **Reports (PDF)** | Admin + Staff | Phase 3 |

### Roles

- **Admin** — Consultway Infotech leadership. Full platform control.
- **Staff** — Consultway operations team. Manage companies, tenders, projects.
- **Company** — Registered private-sector businesses. Self-service portal.

---

## Tech Stack

### Frontend
| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 16** (App Router) | Server Components, Server Actions, file-based routing, Turbopack |
| UI Library | **React 19** | Concurrent rendering, `useActionState`, Server Components |
| Language | **TypeScript 5.6** (strict) | Type safety end-to-end |
| Styling | **TailwindCSS 4.0** | Utility-first, fast dev loop |
| Components | **shadcn/ui** + Radix primitives | Accessible, copy-owned, composable |
| Forms | **React Hook Form + Zod** | Type-safe validation, tiny runtime |
| Data viz | **Recharts** | Dashboard charts |
| Icons | **lucide-react** | Clean, tree-shakeable |
| Animations | **Framer Motion** | Page transitions, micro-interactions |

### Backend
| Layer | Choice | Why |
|---|---|---|
| API | **Next.js Route Handlers** (App Router) | Unified codebase, Server Actions |
| CMS / Backend | **Payload CMS 3.x** | Next.js-native, installs in `/app`, official D1 adapter |
| ORM | **Drizzle ORM** | SQLite-first, Cloudflare D1 compatible, type-safe |
| Auth | **Payload Auth + JWT + bcrypt** | Built into Payload, RBAC-friendly |
| Email | **Resend SDK** | Transactional email, great DX, generous free tier |
| Validation | **Zod** | Shared schemas between client and server |
| Logging | **Pino** | Fast, structured, edge-compatible |

### Database & Storage
| Layer | Choice | Why |
|---|---|---|
| Database | **Cloudflare D1** (SQLite at edge) | Serverless, globally replicated reads, cheap |
| File Storage | **Cloudflare R2** | S3-compatible, zero egress fees |
| Migrations | **Drizzle Kit** | Schema-as-code, TypeScript native |

> ⚠️ **D1 is SQLite, not Postgres.** No native enums (use CHECK constraints),
> no full-text search by default (use `FTS5` virtual tables or a filter-based
> approach), no `JSONB` (use `TEXT` with `JSON.parse`/`stringify`).

### Infrastructure
| Layer | Choice |
|---|---|
| Hosting | **Cloudflare Workers** via `@opennextjs/cloudflare` |
| CI/CD | **GitHub Actions** → Wrangler deploy |
| Secrets | **Wrangler secrets** + `.env.local` for dev |
| Monitoring | Cloudflare Workers Analytics + Sentry (optional) |

---

## Project Structure

```
consultway-ops/
├── .github/
│   └── workflows/              # CI/CD pipelines
│       ├── ci.yml              # Lint + typecheck + test on PR
│       └── deploy.yml          # Deploy to Cloudflare on main
├── docs/                       # Project documentation (see below)
├── drizzle/                    # Generated SQL migrations
├── public/                     # Static assets (logo, favicon)
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (auth)/             # Public auth routes
│   │   │   ├── login/
│   │   │   ├── register/
│   │   │   └── forgot-password/
│   │   ├── (app)/              # Authenticated shell
│   │   │   ├── dashboard/      # Role-aware landing
│   │   │   ├── companies/      # Staff + Admin
│   │   │   ├── tenders/        # All roles
│   │   │   ├── documents/      # Company self-service
│   │   │   ├── projects/       # Phase 3
│   │   │   ├── transactions/   # Admin only, Phase 3
│   │   │   └── settings/
│   │   ├── (payload)/          # Payload CMS admin panel
│   │   │   └── admin/
│   │   ├── api/                # Route handlers
│   │   │   ├── auth/
│   │   │   ├── companies/
│   │   │   ├── documents/
│   │   │   ├── tenders/
│   │   │   ├── uploads/        # R2 presigned URLs
│   │   │   └── webhooks/
│   │   ├── layout.tsx
│   │   └── page.tsx            # Marketing landing → redirect to /login
│   ├── collections/            # Payload CMS collections
│   │   ├── Users.ts
│   │   ├── Companies.ts
│   │   ├── Documents.ts
│   │   ├── Tenders.ts
│   │   ├── TenderApplications.ts
│   │   └── index.ts
│   ├── components/
│   │   ├── ui/                 # shadcn/ui primitives
│   │   ├── layouts/            # Shells, navs, sidebars
│   │   ├── forms/              # Reusable form building blocks
│   │   ├── dashboard/          # Dashboard-specific widgets
│   │   └── shared/             # Misc reusable
│   ├── db/
│   │   ├── schema.ts           # Drizzle schema
│   │   ├── client.ts           # D1 client wrapper
│   │   └── queries/            # Reusable typed queries
│   ├── lib/
│   │   ├── auth/               # Session, RBAC, guards
│   │   ├── email/              # Resend wrapper + templates
│   │   ├── storage/            # R2 upload helpers
│   │   ├── logger.ts           # Pino instance
│   │   ├── constants.ts
│   │   └── utils.ts
│   ├── hooks/                  # Client React hooks
│   ├── types/                  # Shared TS types
│   ├── payload.config.ts       # Payload root config
│   └── middleware.ts           # Next.js middleware (auth gates)
├── scripts/                    # One-off tooling
│   ├── seed.ts
│   └── reset-db.ts
├── tests/
│   ├── e2e/                    # Playwright
│   └── unit/                   # Vitest
├── .env.example
├── .eslintrc.json
├── .gitignore
├── .prettierrc
├── drizzle.config.ts
├── next.config.ts
├── open-next.config.ts
├── package.json
├── pnpm-lock.yaml
├── tailwind.config.ts
├── tsconfig.json
└── wrangler.jsonc              # Cloudflare config (D1, R2 bindings)
```

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 20.11 (LTS recommended)
- **pnpm** ≥ 9 (`npm i -g pnpm`)
- **Wrangler CLI** ≥ 4 (`npm i -g wrangler`)
- A **Cloudflare account** (free tier works for development)
- A **Resend account** for email (optional in local dev)

### 1. Clone and install

```bash
git clone https://github.com/<your-org>/consultway-ops.git
cd consultway-ops
pnpm install
```

### 2. Copy environment variables

```bash
cp .env.example .env.local
```

Fill in the values — see [Environment Variables](#environment-variables).

### 3. Create the D1 database (dev)

```bash
# Creates a local SQLite file under .wrangler/
wrangler d1 create consultway-dev

# Copy the database_id the command prints into wrangler.jsonc
```

### 4. Run migrations

```bash
pnpm db:generate   # Drizzle generates SQL from schema.ts
pnpm db:migrate    # Applies to local D1
```

### 5. Seed admin user

```bash
pnpm db:seed       # Creates a default admin: admin@consultway.info / ChangeMe123!
```

### 6. Start dev server

```bash
pnpm dev           # http://localhost:3000
# Payload admin:  http://localhost:3000/admin
```

---

## Development Phases

The project is delivered in **three phases** over **2–3 weeks of active development**.
See [`docs/03-development-phases.md`](docs/03-development-phases.md) for the
detailed day-by-day plan.

| Phase | Duration | Scope |
|---|---|---|
| **Phase 0 — Foundation** | Days 1–2 | Repo setup, tooling, CI/CD, design system, auth skeleton |
| **Phase 1 — Core (Launchpad)** | Days 3–10 | Auth + RBAC, Companies, Documents, Roster, Admin basics |
| **Phase 2 — Tenders & Notifications** | Days 11–16 | Tender CRUD, applications, eligibility, Resend emails, reminders |
| **Phase 3 — Operations Suite** | Days 17–21 | Projects, Transactions, Reports (PDF), analytics dashboard |

**Launch target:** end of week 3. Phase 3 can be deferred if scope pressure arises
— the Launchpad (Phases 0–2) is independently shippable and matches Proposal A.

---

## Documentation

All project documentation lives in [`docs/`](docs/):

| File | Purpose |
|---|---|
| [`01-project-brief.md`](docs/01-project-brief.md) | Business context, goals, success criteria |
| [`02-tech-stack.md`](docs/02-tech-stack.md) | Detailed stack rationale + tradeoffs |
| [`03-development-phases.md`](docs/03-development-phases.md) | Day-by-day implementation plan |
| [`04-architecture.md`](docs/04-architecture.md) | System architecture, data flow, module diagram |
| [`05-database-schema.md`](docs/05-database-schema.md) | D1/Drizzle schema + entity relationships |
| [`06-api-reference.md`](docs/06-api-reference.md) | REST endpoints + Server Actions |
| [`07-design-system.md`](docs/07-design-system.md) | Colors, typography, components, Figma alignment |
| [`08-rbac-matrix.md`](docs/08-rbac-matrix.md) | Who can do what, per collection |
| [`09-deployment.md`](docs/09-deployment.md) | Cloudflare setup, secrets, CI/CD walkthrough |
| [`10-local-setup.md`](docs/10-local-setup.md) | Detailed local dev guide |
| [`11-coding-standards.md`](docs/11-coding-standards.md) | Conventions, linting, commit style |
| [`12-testing.md`](docs/12-testing.md) | Unit + E2E testing strategy |
| [`CONTRIBUTING.md`](docs/CONTRIBUTING.md) | How to open PRs, branch naming, review checklist |

---

## Environment Variables

See [`.env.example`](.env.example) for the authoritative list. Summary:

```bash
# ─────────── App ───────────
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NODE_ENV="development"

# ─────────── Payload ───────────
PAYLOAD_SECRET="<openssl rand -hex 32>"

# ─────────── Cloudflare D1 (read from wrangler in prod; only needed for tools) ───────────
CLOUDFLARE_ACCOUNT_ID=""
CLOUDFLARE_DATABASE_ID=""
CLOUDFLARE_D1_TOKEN=""

# ─────────── Cloudflare R2 ───────────
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET_NAME="consultway-docs"
R2_PUBLIC_URL=""

# ─────────── Email (Resend) ───────────
RESEND_API_KEY=""
EMAIL_FROM="Consultway <noreply@consultway.info>"
EMAIL_REPLY_TO="hello@consultway.info"

# ─────────── Security ───────────
JWT_SECRET="<openssl rand -hex 64>"
COOKIE_DOMAIN="localhost"
```

---

## Scripts

```bash
# Development
pnpm dev                  # Start Next.js dev server (Turbopack)
pnpm build                # Production build
pnpm start                # Run production build locally

# Database
pnpm db:generate          # Generate Drizzle migrations from schema
pnpm db:migrate           # Apply migrations to local D1
pnpm db:migrate:prod      # Apply migrations to remote D1
pnpm db:seed              # Seed default admin + demo data
pnpm db:studio            # Drizzle Studio (visual DB browser)
pnpm db:reset             # ⚠️ Wipe local DB + re-migrate + seed

# Payload
pnpm payload              # Payload CLI (e.g., `pnpm payload generate:types`)

# Quality
pnpm lint                 # ESLint
pnpm lint:fix             # ESLint with --fix
pnpm typecheck            # tsc --noEmit
pnpm format               # Prettier write
pnpm test                 # Vitest
pnpm test:e2e             # Playwright

# Deployment
pnpm preview              # Build + run with Wrangler locally
pnpm deploy               # Deploy to Cloudflare
pnpm deploy:preview       # Deploy to preview environment
```

---

## Deployment

Summary (full guide: [`docs/09-deployment.md`](docs/09-deployment.md)):

1. **First-time Cloudflare setup**
   - Create D1 database: `wrangler d1 create consultway-prod`
   - Create R2 bucket: `wrangler r2 bucket create consultway-docs`
   - Bind both in `wrangler.jsonc`
2. **Push secrets**
   - `wrangler secret put PAYLOAD_SECRET`
   - `wrangler secret put RESEND_API_KEY`
   - `wrangler secret put JWT_SECRET`
3. **Deploy**
   - `pnpm deploy` (or let GitHub Actions do it on push to `main`)

---

## Contributing

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md). Quick rules:

- **Branch naming:** `feat/<ticket>-short-desc`, `fix/…`, `chore/…`, `docs/…`
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, etc.)
- **PRs:** Must pass `lint + typecheck + test` before review. Squash-merge.
- **Code style:** Enforced by ESLint + Prettier on pre-commit.

---

## License

Proprietary — © 2026 Consultway Infotech. Built by Code Uncode.

## Contact

- **Technical lead:** [Your name] · `you@codeuncode.com`
- **Client:** Consultway Infotech · `hello@codeuncode.com`
