# Deploy — Layer A (staging on workers.dev, via GitHub Actions)

Operator checklist for the first remote deploy. Goal: a live URL at
`https://consultway-ops-staging.<your-cloudflare-subdomain>.workers.dev`
that you can sign into as admin and exercise end-to-end against real
D1 + R2.

This is **staging**, not production. No custom domain, no public
registration trust yet, no Resend domain verified — emails will fall
back to the structured logger.

> The build + deploy itself runs on **GitHub Actions (Ubuntu)**, not
> from your local machine. OpenNext doesn't support Windows and even
> on macOS pinning the build environment makes "CI passed" a
> meaningful signal. Your local Windows machine stays as the dev
> environment.

## 0. Prerequisites

- [ ] Cloudflare account exists. (You probably already have one — the
      R2 creds in `.env.local` came from somewhere.)
- [ ] You're on Workers Paid plan ($5/month). Free works for the
      first deploy but D1 + R2 quotas are tight; bump before the demo.
- [ ] You have admin access to the GitHub repo (you need to set
      repo secrets in step 1).
- [ ] Latest `dev` branch pulled locally, working tree clean.
- [ ] `pnpm install` succeeded after the latest pull (you need
      `@opennextjs/cloudflare` + `wrangler` from the recent install).

## 1. Mint a Cloudflare API token + add to GitHub Secrets

In the Cloudflare dashboard:

1. Go to **Profile → API Tokens** (top-right avatar → My Profile).
2. Click **Create Token**.
3. Use the **"Edit Cloudflare Workers"** template, OR build a custom
   token with these permissions:
   - **Account → Workers Scripts: Edit**
   - **Account → Workers KV Storage: Edit**
   - **Account → D1: Edit**
   - **Account → R2: Edit**
   - **Zone → DNS: Edit** (only needed when you point a custom
     domain at the Worker — Layer B+)
4. Set Account Resources → Include → **your account**.
5. (Optional) Set IP filters / TTL if you want.
6. **Copy the token immediately** — Cloudflare shows it once.

In the GitHub repo (`allstarmayu/consultway-ops`):

1. Go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `CLOUDFLARE_API_TOKEN`, value: paste the token. Add.
4. (Recommended) Add a second secret `CLOUDFLARE_ACCOUNT_ID` — find
   the value in any Cloudflare dashboard page URL or right-rail panel.
   Some wrangler commands resolve it from the token, but explicit is
   safer if you have multiple Cloudflare accounts attached.

## 2. Local wrangler auth (one-time, for the create-resources step)

The actual deploys run on Actions, but **creating** the D1 / KV / R2
resources is a one-time setup step you run locally. Skipping CI for
the create step keeps the workflow file simple.

```bash
pnpm exec wrangler login
```

A browser tab opens. Approve. Verify:

```bash
pnpm exec wrangler whoami
```

## 3. Create the D1 staging database

```bash
pnpm exec wrangler d1 create consultway-staging
```

Output ends with a `database_id` UUID. Open `wrangler.jsonc`, find
`env.staging.d1_databases[0]`, replace `REPLACE_WITH_STAGING_D1_UUID`
with that UUID. **Commit the change** — the deploy workflow needs it.

## 4. Create the KV namespaces

The wrangler config declares two KV bindings (`SESSIONS` and
`RATE_LIMITS`) at the top level (inherited by `staging`). Not used by
code today — they're pre-wired for D33+ work — but the deploy fails
if the IDs are placeholders.

```bash
pnpm exec wrangler kv namespace create SESSIONS
pnpm exec wrangler kv namespace create RATE_LIMITS
```

Each command prints an `id`. Paste both into `wrangler.jsonc` at the
top-level `kv_namespaces` block, replacing the two
`REPLACE_WITH_KV_UUID` placeholders. Commit + push.

## 5. Create the R2 staging bucket + apply CORS

```bash
pnpm exec wrangler r2 bucket create consultway-docs-staging
pnpm exec wrangler r2 bucket cors set consultway-docs-staging --file infra/r2-cors.json --force
pnpm exec wrangler r2 bucket cors list consultway-docs-staging
```

The third command should print back the rules including the
`*.workers.dev` wildcard origin.

## 6. Push secrets to the staging environment

Secrets live in Cloudflare, not in GitHub or your repo. They're set
once via `wrangler secret put` and persist across deploys.

Generate fresh secrets (don't reuse dev placeholders):

```bash
# JWT_SECRET (64-char hex)
openssl rand -hex 32
# Paste the output as the value when prompted by the next command.
pnpm exec wrangler secret put JWT_SECRET --env staging

# PASSWORD_PEPPER (32-char hex)
openssl rand -hex 16
pnpm exec wrangler secret put PASSWORD_PEPPER --env staging
```

R2 credentials — same values from your local `.env.local` work
(account-scoped, not bucket-specific):

```bash
pnpm exec wrangler secret put R2_ACCOUNT_ID --env staging
pnpm exec wrangler secret put R2_ACCESS_KEY_ID --env staging
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY --env staging

# Bucket name override — staging uses consultway-docs-staging, not
# the default consultway-docs. Set as a secret rather than a var so
# we don't have to repeat the binding-name dance in wrangler.jsonc.
echo "consultway-docs-staging" | pnpm exec wrangler secret put R2_BUCKET_NAME --env staging
```

`RESEND_API_KEY` is **deliberately skipped** for Layer A. Without it,
`lib/email/client.ts` falls back to logging the rendered email
payload via the structured logger and returns `{ok: true}`. The cron
+ auth flows still write to the DB and the audit log; users just
don't get real emails. We'll add Resend in Layer B.

Verify the secret list:

```bash
pnpm exec wrangler secret list --env staging
```

Expect 6 entries: JWT_SECRET, PASSWORD_PEPPER, R2_ACCOUNT_ID,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.

## 7. Push the wiring commit + watch the first deploy

The `.github/workflows/deploy-staging.yml` workflow triggers on every
push to `dev`. After the previous steps you should have local edits
to `wrangler.jsonc` (real D1 + KV UUIDs). Push them:

```bash
git add wrangler.jsonc
git commit -m "ops: real Cloudflare D1 + KV ids for staging"
git push origin dev
```

Now open the **Actions** tab on GitHub. Watch the "Deploy Staging"
workflow run. Steps:

1. Install pnpm + Node 20 + deps
2. Typecheck + tests (safety net)
3. Apply D1 migrations against staging
4. Build worker (OpenNext)
5. Deploy via cloudflare/wrangler-action

Expected runtime: 3-5 minutes. When the workflow completes, the
"Print deploy URL" step writes a summary at the top of the Actions
run page. The Worker URL also shows up in the deploy step's log:

```
Deployed consultway-ops-staging triggers (...)
  https://consultway-ops-staging.<your-subdomain>.workers.dev
```

**Note the URL.** That's your staging app.

### What if the deploy fails

Most likely first-deploy failures:

- **`@opennextjs/cloudflare` peer warning escalates to an error.**
  We're on Next `16.2.4`; the adapter wants `>=16.2.6`. If this bites
  the OpenNext build, the fix is a patch bump:
  `pnpm add next@^16.2.6 react react-dom`. Commit and push again.
- **"Could not find a D1 database with the id ..."** — a placeholder
  is still in `wrangler.jsonc`. Re-check step 3.
- **"binding KV namespace not found"** — placeholder in the
  `kv_namespaces` block. Re-check step 4.
- **Migrations fail** with "no such table" — the migrations apply
  step actually creates the schema; if it crashes mid-stream it could
  leave the DB partial. Drop and recreate the staging DB to start
  fresh: `wrangler d1 delete consultway-staging` then back to step 3.

## 8. Seed an admin user

Don't run `pnpm db:seed` against the remote — that hits the local
SQLite, not the remote D1 binding. We'll do this manually with a
single INSERT.

Generate a bcrypt hash locally for the admin password (use the SAME
PASSWORD_PEPPER value you set in step 6 — they have to match or
login will silently reject):

```bash
node -e "
const bcrypt = require('bcryptjs');
const pepper = '<paste-the-PASSWORD_PEPPER-from-step-6>';
const password = 'YourActualStrongPassword!';
console.log(bcrypt.hashSync(password + pepper, 10));
"
```

Then insert (the `id` column has a UUID v7 default — omit it and SQLite
generates one):

```bash
pnpm exec wrangler d1 execute consultway-staging --remote --env staging \
  --command "INSERT INTO users (email, password_hash, role, name, email_verified_at) VALUES ('you@yourdomain.com', '<paste-bcrypt-hash>', 'admin', 'Mayuresh Dongare', datetime('now'));"
```

Verify:

```bash
pnpm exec wrangler d1 execute consultway-staging --remote --env staging \
  --command "SELECT id, email, role, name FROM users;"
```

## 9. Post-deploy verification

In a browser:

```
https://consultway-ops-staging.<your-subdomain>.workers.dev/api/health
```

Expect: `{"status":"ok","version":"...","timestamp":"..."}` with 200.

Then visit the root URL, hit /login, sign in with the admin
credentials from step 8. Navigate through:

- [ ] Dashboard loads
- [ ] Companies list (empty — production-grade, just one admin user)
- [ ] Settings → Profile (avatar upload works against the staging R2 bucket)
- [ ] Tenders list
- [ ] Sign out works

If you see a 502 / 500 on first visit, tail the worker logs locally:

```bash
pnpm exec wrangler tail --env staging
```

…and reload the page. Most "first deploy" issues are missing secrets
(`wrangler secret list --env staging` should show 6 entries) or
KV/D1 binding mismatch.

## 10. Subsequent deploys

Every push to `dev` triggers a new deploy. Manual re-deploy without
a commit: GitHub repo → Actions tab → "Deploy Staging" → **Run
workflow** button (top-right of the workflow page).

The workflow caches `pnpm install` across runs, so re-deploys after
the first one take ~2 minutes instead of 4-5.

## Rollback

If something is broken after deploy:

```bash
# List recent versions (locally)
pnpm exec wrangler deployments list --env staging

# Roll back to a previous version
pnpm exec wrangler rollback <deployment-id> --env staging
```

D1 migrations are forward-only — don't roll back a bad migration;
ship a new migration that reverses it.

## What's done after Layer A

- [ ] Cloudflare account active, Workers Paid plan ON
- [ ] `CLOUDFLARE_API_TOKEN` in GitHub repo secrets
- [ ] Real D1 + KV + R2 bindings, IDs filled in `wrangler.jsonc`
- [ ] Secrets in place for staging environment
- [ ] GitHub Actions deploy workflow green
- [ ] Migrations applied against the remote D1
- [ ] Admin user seeded
- [ ] Staging URL accessible, `/api/health` returns 200
- [ ] Manual smoke walk-through complete

Then Layer B (real domain + Resend + rate limits) and Layer C (open
registration + 2FA + monitoring) are next on the deploy roadmap.

## Troubleshooting reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Actions workflow doesn't trigger | Push wasn't to `dev` branch | Push to `dev`, or use **Run workflow** button |
| `Error: Cloudflare API token not provided` | `CLOUDFLARE_API_TOKEN` not set in GitHub Secrets | Step 1 |
| `Error: Unauthorized` on D1 migration step | Token missing D1 permission | Re-mint token with D1:Edit |
| OpenNext build fails with `__filename is not defined` | Was a Windows-only bug; CI is Ubuntu so should not bite. If it does, file a bug | — |
| Login form rejects valid password | `PASSWORD_PEPPER` mismatch — hash was computed with one pepper, worker validates with another | Re-run step 8 with the correct pepper |
| Avatar upload fails with `SignatureDoesNotMatch` | R2 bucket-name mismatch | Confirm `R2_BUCKET_NAME` secret set in step 6 |
| `Could not find a D1 database` | Placeholder still in `wrangler.jsonc` | Re-check step 3, commit + push |
| Cron didn't fire when expected | Cloudflare runs crons in UTC | Run `wrangler tail --env staging` overnight, or trigger manually via dashboard |
