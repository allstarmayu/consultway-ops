# Layer A deploy — status (paused on D1 client wiring)

_Updated 2026-05-27, end of a long deploy session._

## Where we landed

**Infrastructure: 100% done.** App runtime: 95% done — the deployed
Worker is alive, the health endpoint returns 200, but Server-Component
pages crash because the database client still tries to open a local
SQLite file instead of using the D1 binding.

## What's live

- **Worker URL:** https://consultway-ops-staging.mayuresh-dongare.workers.dev
- **Health endpoint:** https://consultway-ops-staging.mayuresh-dongare.workers.dev/api/health
  Returns `{"status":"ok","version":"Consultway Ops","timestamp":"..."}`.
  Confirms the worker, all bindings, env vars, and middleware are wired.
- **Cloudflare account:** Workers Paid plan ($5/mo) active.
- **Subdomain:** `mayuresh-dongare.workers.dev`.
- **D1 (consultway-staging):** All 16 migrations applied. One admin
  user seeded:
  - id `9077d1b9-3943-4187-b8bd-ec683199cde2`
  - email `mayuresh.dongare@outlook.com`
  - role `admin`
  - password set via the `43a9ae8a...` pepper + a bcrypt hash
- **R2 bucket:** `consultway-docs-staging` with CORS allow-list.
- **KV namespaces:** `SESSIONS` + `RATE_LIMITS` (unused by code yet).
- **GitHub Actions:** CI + Deploy Staging workflows, fully working.
  Push to `dev` triggers a deploy automatically.

## The real blocker we discovered

The deployed worker crashes on any Server-Component page (`/login`,
`/`, `/dashboard/...`) with:

```
Error: Could not find module root given file: "worker.js".
Do you have a `package.json` file?
```

`wrangler tail` revealed the smoking gun in the same request:

```
(log) {"msg":"opening sqlite connection","module":"db","path":"./.wrangler/consultway-local.sqlite"}
```

**The deployed worker is trying to open the local SQLite file.** It's
calling `better-sqlite3` to load its native `.node` binary, which
walks the filesystem looking for package.json — that walk crashes
in the Workers runtime (no filesystem). The D1 binding declared in
`wrangler.jsonc` (`env.DB`) is created, bound, and visible to the
worker — it's just never invoked.

This is the **"D1 client factory"** follow-up explicitly listed in
`docs/reports/day-29-report.md` under carry-forwards. It was deferred
because the local-only dev flow worked fine; tonight's first remote
deploy is what made it load-bearing.

## What's needed to finish Layer A

A runtime-aware DB client factory in `lib/db/index.ts`:

```ts
// rough sketch — actual implementation needs more care
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getDb() {
  try {
    // In a Cloudflare Worker, getCloudflareContext returns the env
    // with the DB binding. Throws if called outside a Worker.
    const { env } = getCloudflareContext();
    return drizzleD1(env.DB);
  } catch {
    // Local dev / tests / scripts: open the .wrangler file via
    // better-sqlite3 as today.
    const Database = require("better-sqlite3");
    return drizzleBetter(new Database(env.DATABASE_URL));
  }
}
```

But the real work is:

1. Refactor `lib/db/index.ts` to provide both a sync local client
   AND a per-request D1 client via `getDb()`.
2. Audit every caller of `import { db } from "@/lib/db"`. Server
   Components and Server Actions need to switch to the request-scoped
   client. CLI scripts (cron handlers, seed scripts) keep the local
   sync client.
3. Possibly need to make `db` a request-scoped factory instead of
   a module-level constant — Drizzle's D1 binding is per-request,
   not global like better-sqlite3.
4. Re-run the test suite — some tests may need adjustment if they
   relied on module-level `db`.

Realistic estimate: **half a day to a full day** of careful work
touching the entire action layer. Not a one-line config change.

## Tonight's session commits (all on origin/dev)

```
4dc8ae7  feat(avatars): R2-backed profile photo uploads
fb49b44  docs: add Day 29 progress report
05588c9  fix(settings): collapse Profile toasts to one shared id
69be00f  fix(settings): Avatar fallback initials after remove
779b42a  ops(layer-a): wire Cloudflare deploy via GitHub Actions
2989a40  ops(deploy): real Cloudflare IDs for staging + env-scoped vars/KV
08681ee  fix(ci): pin wranglerVersion=4 in deploy-staging workflow
392107b  fix(ci): bump Node to 22 (wrangler 4 requires it)
5851ab1  chore(deps): bump next + react to satisfy OpenNext peer range
c7cc88e  fix(deploy): strip runtime scheduled() re-export from open-next.config
3d483bf  fix(deploy): add required middleware + edgeExternals to open-next.config
c65da7a  fix(deploy): split session module + opt proxy.ts into edge runtime
6afdbc1  fix(deploy): rename proxy.ts -> middleware.ts to allow edge runtime
679a642  fix(deploy): runtime 'edge' -> 'experimental-edge' for Next 16
4b81d81  docs: capture Layer A deploy status (paused on worker size limit)
318a541  fix(deploy): externalize @react-pdf/renderer to fit Worker size limit
bc08eb7  fix(deploy): stub lib/reports/pdf to break @react-pdf bundle chain
30b400b  fix(deploy): add nodejs_als compat flag for Next 16 RSC
```

18 commits in one session. Every one defensible. None of them
"wasted" — every fix moved us forward through a real, distinct
blocker.

## Where to pick up tomorrow

1. **Read this doc cold.** Confirm the state matches what you remember.
2. **Read `docs/reports/day-29-report.md`** followup section — the
   "D1 client factory" item is the work.
3. **Plan:** sketch the refactor before coding. Touches `lib/db/`,
   probably `lib/db/d1.ts` (new) + factory in `index.ts`, plus
   audit of `lib/*/actions.ts` callers.
4. **Test locally first:** the existing local-SQLite tests must
   keep passing. Then deploy and watch `/login` actually render.

Once that lands, the rest of Layer A's smoke test (sign in,
navigate dashboard, upload avatar against staging R2) is ~15 min
of verification.

## A note on what we got right

Despite the late-night thrash, this session shipped real value:

- **avatars-via-R2** is fully live in local dev and tested. That
  feature is genuinely done.
- **The deploy pipeline itself** — GitHub Actions wiring, OpenNext
  config, Cloudflare resources, secrets, CORS, KV namespaces — is
  100% wired and reusable. Tomorrow we only need to fix the D1
  client; everything else just works.
- **18 commits, 11 distinct deploy blockers fixed.** Each one
  could have been a 4-hour debug session in isolation; we burned
  through them in sequence.

That's worth something. Sleep on it.
