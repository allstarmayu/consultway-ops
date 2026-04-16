# 09 — Deployment

End-to-end guide for deploying Consultway Ops to Cloudflare — from zero to a
live `portal.consultway.info` URL.

---

## Prerequisites (one-time)

1. **Cloudflare account** (free tier works for dev; Workers Paid plan at $5/mo
   is recommended for prod because of D1/R2 usage patterns).
2. **Cloudflare API token** with these permissions:
   - Workers Scripts: Edit
   - Workers Routes: Edit
   - D1: Edit
   - R2: Edit
   - Zone: DNS Edit (for the Consultway domain)
3. **Wrangler CLI** installed: `npm i -g wrangler@latest`
4. **Authenticated:** `wrangler login`
5. **Domain set up in Cloudflare:** `consultway.info` zone exists and DNS is
   managed by Cloudflare.

---

## 1. Create the D1 Databases

```bash
# Development / staging DB
wrangler d1 create consultway-dev

# Production DB
wrangler d1 create consultway-prod
```

Each command prints a `database_id` UUID. Copy them into `wrangler.jsonc`.

---

## 2. Create the R2 Bucket

```bash
# Single bucket works for both envs; prefix by environment in object keys
wrangler r2 bucket create consultway-docs

# (Optional) set up a public bucket for avatars only
wrangler r2 bucket create consultway-public
```

**Bucket policy:** the `consultway-docs` bucket stays private. We serve files
through short-lived presigned URLs. The `consultway-public` bucket (optional)
can have public access for user avatars.

**R2 credentials for aws4fetch:**

1. In Cloudflare dashboard → R2 → Manage API Tokens → Create API Token
2. Permissions: Object Read & Write, scope to the `consultway-docs` bucket
3. Save the `Access Key ID` and `Secret Access Key`

---

## 3. Configure `wrangler.jsonc`

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

  // ─── Default (dev) bindings ───
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "consultway-dev",
      "database_id": "<dev-db-id>",
      "migrations_dir": "drizzle"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "consultway-docs"
    }
  ],
  "vars": {
    "NEXT_PUBLIC_APP_URL": "http://localhost:3000"
  },

  // ─── Cron (daily reminders) ───
  "triggers": {
    "crons": ["30 0 * * *"]
  },

  // ─── Production environment ───
  "env": {
    "production": {
      "name": "consultway-ops",
      "routes": [
        { "pattern": "portal.consultway.info", "custom_domain": true }
      ],
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "consultway-prod",
          "database_id": "<prod-db-id>",
          "migrations_dir": "drizzle"
        }
      ],
      "r2_buckets": [
        { "binding": "R2", "bucket_name": "consultway-docs" }
      ],
      "vars": {
        "NEXT_PUBLIC_APP_URL": "https://portal.consultway.info",
        "NODE_ENV": "production"
      }
    }
  }
}
```

---

## 4. Push Secrets

Secrets **never** go in `wrangler.jsonc` — they go via `wrangler secret`:

```bash
# Per environment — repeat with --env production for prod
wrangler secret put PAYLOAD_SECRET
# Paste: openssl rand -hex 32

wrangler secret put JWT_SECRET
# Paste: openssl rand -hex 64

wrangler secret put RESEND_API_KEY
# Paste: re_...

wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET_NAME  # consultway-docs

# Production versions:
wrangler secret put PAYLOAD_SECRET --env production
# ... repeat for each
```

---

## 5. Run Migrations

Drizzle generates SQL migration files from `src/db/schema.ts`. These are
applied via Wrangler.

```bash
# Generate migration (writes SQL to drizzle/)
pnpm db:generate

# Apply to local dev DB (uses --local flag — SQLite file in .wrangler/)
wrangler d1 migrations apply consultway-dev --local

# Apply to remote dev DB
wrangler d1 migrations apply consultway-dev --remote

# Apply to remote PROD DB (be careful!)
wrangler d1 migrations apply consultway-prod --remote --env production
```

The `package.json` scripts wrap these:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply consultway-dev --local",
    "db:migrate:dev": "wrangler d1 migrations apply consultway-dev --remote",
    "db:migrate:prod": "wrangler d1 migrations apply consultway-prod --remote --env production"
  }
}
```

---

## 6. Build & Deploy

```bash
# Build the Next.js app for Cloudflare
pnpm build           # runs: next build && opennextjs-cloudflare build

# Deploy to dev environment
wrangler deploy

# Deploy to production
wrangler deploy --env production
```

---

## 7. Custom Domain

Point `portal.consultway.info` at the Worker:

**Option A — via Wrangler (preferred):**

Already declared in `wrangler.jsonc` production env under `routes`. On deploy,
Wrangler creates the Custom Domain mapping automatically.

**Option B — via Cloudflare dashboard:**

1. Workers & Pages → `consultway-ops` → Settings → Triggers → Custom Domains
2. Add `portal.consultway.info`
3. Cloudflare automatically creates an `AAAA` record

Cloudflare provisions the TLS certificate automatically (Universal SSL).

---

## 8. Post-Deploy Verification

Run this checklist after every deploy:

```bash
# Health check
curl -i https://portal.consultway.info/api/health
# Expect: 200 + { "status": "ok" }

# Static assets
curl -I https://portal.consultway.info/favicon.ico
# Expect: 200

# Auth redirect
curl -I https://portal.consultway.info/dashboard
# Expect: 307 redirect to /login
```

Plus a manual smoke test:
- [ ] Home page loads
- [ ] Can log in as admin
- [ ] Dashboard renders
- [ ] Can click into companies → roster loads
- [ ] Log out works
- [ ] Registration flow works end-to-end on a throwaway email

---

## GitHub Actions CI/CD

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
        env:
          PAYLOAD_SECRET: test-secret-for-build-only
```

### `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
        env:
          PAYLOAD_SECRET: ${{ secrets.PAYLOAD_SECRET }}
          JWT_SECRET: ${{ secrets.JWT_SECRET }}
      - name: Run D1 migrations (production)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: d1 migrations apply consultway-prod --remote --env production
      - name: Deploy to Cloudflare
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: deploy --env production
```

### Required GitHub secrets

Set in repo Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — from Cloudflare dashboard
- `PAYLOAD_SECRET`, `JWT_SECRET`, etc — used during build
- (Optional) `RESEND_API_KEY` if build-time email templating needs it

---

## Rollback

If a deploy breaks prod:

```bash
# List recent versions
wrangler deployments list --env production

# Roll back to previous
wrangler rollback <deployment-id> --env production
```

D1 migrations are forward-only. If a migration caused the issue, write a new
migration that reverses it — don't try to undo one in-place.

---

## Monitoring

### Logs

```bash
# Tail Worker logs in real-time
wrangler tail --env production

# Filter
wrangler tail --env production --format json | jq 'select(.outcome == "exception")'
```

### Dashboard

Cloudflare Workers dashboard → `consultway-ops` → shows:
- Request count / error rate / CPU time
- D1 query count / error rate
- R2 requests / storage

### Health check (Cloudflare)

Dashboard → Health Checks → Create:
- URL: `https://portal.consultway.info/api/health`
- Expected status: 200
- Interval: 60s
- Notifications: email on failure

---

## Cost Targets

| Service | Expected monthly cost |
|---|---|
| Workers Paid plan | $5 (~ ₹420) |
| D1 — <5M reads/mo, <100k writes/mo | $0 |
| R2 — <10 GB storage, <1M Class A ops | ~$1 (~ ₹85) |
| Cloudflare custom domain | $0 (included) |
| Resend — <3k emails/mo | $0 |
| **Total** | **₹500–600/month** |

Scales linearly with usage. Even at 10× traffic, still well under the
₹2,000/month proposal target.

---

## Disaster Recovery

### D1 backups

D1 has **Time Travel** — point-in-time restore to any moment in the last 30 days
(free tier: 24 hours). No manual backups needed.

```bash
# Restore to 1 hour ago
wrangler d1 time-travel restore consultway-prod --timestamp "2026-04-15T14:00:00Z"
```

### R2 backups

R2 doesn't have Time Travel. For critical documents:
- Enable versioning: `wrangler r2 bucket versioning enable consultway-docs`
- Cross-region replication via a scheduled Worker (Phase 3+, only if needed)

### Application code

All in GitHub. To roll back infrastructure + code:
1. `git revert` the bad commit
2. Push → CI/CD redeploys
