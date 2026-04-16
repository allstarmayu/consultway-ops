# Local Development Setup

This guide gets a new contributor from a fresh laptop to a running dev server in under 30 minutes.

## 1. Prerequisites

Install these once per machine:

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS (≥20.11) | https://nodejs.org or `nvm install 20` |
| pnpm | 9.x | `npm install -g pnpm@9` |
| Git | any recent | https://git-scm.com |
| Wrangler CLI | 3.x | `npm install -g wrangler` |
| VS Code (recommended) | latest | https://code.visualstudio.com |

Verify:

```bash
node --version    # v20.x.x
pnpm --version    # 9.x.x
wrangler --version
git --version
```

### Recommended VS Code Extensions

- ESLint (`dbaeumer.vscode-eslint`)
- Prettier (`esbenp.prettier-vscode`)
- Tailwind CSS IntelliSense (`bradlc.vscode-tailwindcss`)
- Drizzle ORM (`drizzle-team.drizzle-vscode`)
- GitLens (`eamodio.gitlens`)

The repo ships a `.vscode/extensions.json` that will prompt you to install these on first open.

## 2. Clone & Install

```bash
git clone git@github.com:<org>/consultway-ops.git
cd consultway-ops
pnpm install
```

If `pnpm install` fails with a network error inside India, switch the registry mirror:

```bash
pnpm config set registry https://registry.npmmirror.com
```

## 3. Environment Variables

Copy the template and fill in local values:

```bash
cp .env.example .env.local
```

For **local-only** development you need these at minimum:

```env
NODE_ENV=development
NEXT_PUBLIC_APP_URL=http://localhost:3000
PAYLOAD_SECRET=<generate with: openssl rand -base64 32>
JWT_SECRET=<generate with: openssl rand -base64 32>

# D1 runs locally via Miniflare — no remote credentials needed for dev
DATABASE_URL=file:./.wrangler/state/v3/d1/miniflare-D1DatabaseObject/consultway_local.sqlite

# R2 — local dev uses Miniflare's in-memory bucket
R2_BUCKET=consultway-docs-local
R2_ACCOUNT_ID=local
R2_ACCESS_KEY_ID=local
R2_SECRET_ACCESS_KEY=local
R2_PUBLIC_URL=http://localhost:3000/r2

# Email — use Resend's test mode or MailHog for dev
RESEND_API_KEY=re_test_xxxxxxxxxxxxx
EMAIL_FROM=dev@consultway.local
```

**Never commit `.env.local`.** It is in `.gitignore`. Secrets for staging/production live in Cloudflare — see [09-deployment.md](./09-deployment.md).

## 4. Initialize the Database

Run migrations against the local D1 instance:

```bash
pnpm db:migrate:local
```

Seed with sample admin + demo company + demo tender:

```bash
pnpm db:seed
```

The seeder logs the admin credentials to stdout:

```
✔ Admin created: admin@consultway.local / ChangeMe123!
✔ Company created: demo.co@example.com / Demo12345!
✔ 3 sample tenders inserted
```

## 5. Start the Dev Server

```bash
pnpm dev
```

Open http://localhost:3000. The Payload admin UI is at http://localhost:3000/admin.

On first run Next.js compiles the app — expect 15-30 seconds. Subsequent hot reloads are sub-second.

## 6. Verify the Setup

Run the health-check script:

```bash
pnpm verify
```

This runs, in order:

1. TypeScript type check (`tsc --noEmit`)
2. ESLint
3. Unit tests (Vitest)
4. A smoke test that hits `/api/health` and expects `{ ok: true }`

All four must pass before you open a PR.

## 7. Common Commands

```bash
# Development
pnpm dev                 # Next.js dev server
pnpm dev:payload         # Payload admin only (rarely needed)

# Database
pnpm db:generate         # Generate Drizzle migrations from schema changes
pnpm db:migrate:local    # Apply migrations to local D1
pnpm db:migrate:prod     # Apply migrations to production (CI only)
pnpm db:studio           # Drizzle Studio — visual DB browser
pnpm db:seed             # Seed local DB
pnpm db:reset            # Drop & recreate local DB (destructive)

# Quality
pnpm lint                # ESLint
pnpm lint:fix            # ESLint with autofix
pnpm format              # Prettier write
pnpm typecheck           # tsc --noEmit
pnpm verify              # lint + typecheck + test

# Testing
pnpm test                # Vitest unit tests
pnpm test:watch          # Vitest in watch mode
pnpm test:e2e            # Playwright E2E tests
pnpm test:e2e:ui         # Playwright with UI runner

# Build & Deploy
pnpm build               # Next.js production build
pnpm preview             # Build + run via @opennextjs/cloudflare locally
pnpm deploy              # Deploy to Cloudflare (CI only — don't run manually)
```

## 8. Troubleshooting

### `Error: D1_ERROR: no such table`
You haven't run migrations. Run `pnpm db:migrate:local`.

### `Port 3000 already in use`
Another process is holding the port. Either kill it or run on a different port:
```bash
PORT=3001 pnpm dev
```

### `Payload admin shows "Unauthorized"` after login
Cookies may be stale. Clear cookies for `localhost:3000` and log in again. If the problem persists, `PAYLOAD_SECRET` in `.env.local` was changed after you created accounts — reseed the DB.

### `pnpm install` is slow or hanging
Clear the store and retry:
```bash
pnpm store prune
rm -rf node_modules .next
pnpm install
```

### Tailwind classes not applying
Restart the dev server. Tailwind 4 watches `content` paths but occasionally misses new files on first creation.

### Drizzle Studio won't connect
Studio needs the SQLite file to exist. Run `pnpm db:migrate:local` first.

### Wrangler asks to log in during `pnpm dev`
You don't need to log in for local dev. If prompted, you're probably running `pnpm preview` (which uses Miniflare locally but still reads `wrangler.jsonc`). For pure local dev, stick to `pnpm dev`.

## 9. Git Hooks

Husky is installed automatically on `pnpm install`. On every commit:

1. `lint-staged` runs Prettier + ESLint on staged files
2. Commitlint validates the commit message against Conventional Commits

If a commit is rejected, fix the reported issue and retry. To bypass in emergencies (don't — use `git commit --no-verify`).

## 10. Keeping Your Branch Fresh

```bash
git fetch origin
git rebase origin/main     # prefer rebase over merge for feature branches
pnpm install               # pick up any lockfile changes
pnpm db:migrate:local      # apply any new migrations
```

---

**Next:** Read [11-coding-standards.md](./11-coding-standards.md) before writing code.
