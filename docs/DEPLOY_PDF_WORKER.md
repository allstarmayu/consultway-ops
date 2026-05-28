# Deploy — PDF Worker (`consultway-ops-pdf`)

Operator checklist for the dedicated PDF-rendering worker. Goal: the
`/dashboard/reports/pdf` download button works again on staging by
offloading `@react-pdf/renderer` into a sibling worker that the main
worker calls over a service binding.

## Why this worker exists

`@react-pdf/renderer` is ~5-7 MiB minified. On Day 30 it pushed the main
OpenNext worker over Cloudflare's 10 MiB Workers Paid ceiling, so the
renderer was stubbed and PDF downloads returned a 503. This worker owns
the renderer in its own bundle. The main worker (`consultway-ops`) reaches
it over a **service binding** (`env.PDF_WORKER`); the request never leaves
Cloudflare's network.

- **Source:** `workers/pdf/` (`wrangler.jsonc`, `src/index.ts`).
- **Renderer:** `lib/reports/pdf-renderer.tsx` (single source of truth,
  bundled into this worker by wrangler's esbuild).
- **Dispatcher (main worker side):** `lib/reports/pdf.tsx`.
- **No public URL.** `workers_dev: false` — reachable only via the
  binding. `/render` therefore needs no auth (nothing off-network can
  reach it).

## 0. Prerequisites

- [ ] Workers Paid plan active (already true since Layer A).
- [ ] `CLOUDFLARE_API_TOKEN` (+ optional `CLOUDFLARE_ACCOUNT_ID`) already
      set as GitHub repo secrets (done in Layer A — same token works,
      it has Workers Scripts: Edit).
- [ ] Local `wrangler login` done (for the one-time first deploy below),
      OR you can trigger the workflow manually from the Actions tab.
- [ ] Latest `dev` pulled, `pnpm install` run.

## 1. First deploy is MANUAL and must come FIRST

The main worker's service binding (`wrangler.jsonc` → `env.staging.services`)
references `consultway-ops-pdf-staging` **by name**. That target worker
must already exist, or the main worker deploy will fail to resolve the
binding. So the very first time, deploy the PDF worker before the next
main-worker deploy:

```bash
# From the repo root, with wrangler logged in:
pnpm deploy:pdf-worker:staging
#   → wrangler deploy --config workers/pdf/wrangler.jsonc --env staging
```

Expected: wrangler bundles `src/index.ts` (+ the renderer + React +
@react-pdf/renderer), uploads, and prints the worker name
`consultway-ops-pdf-staging` with **no** `*.workers.dev` URL (because
`workers_dev: false`).

> Prefer not to deploy from your machine? Trigger **Deploy PDF Worker
> (staging)** from the GitHub Actions tab (`workflow_dispatch`) instead.
> It does the same `wrangler deploy --config ... --env staging`.

## 2. Deploy / re-deploy the main worker

Once the PDF worker exists, push to `dev` as usual. The existing
`deploy-staging.yml` deploys the main worker, which now declares the
`PDF_WORKER` binding — it resolves cleanly because step 1 created the
target.

## 3. Ongoing deploys are automatic

- `deploy-pdf-staging.yml` fires on push to `dev` **only when**
  `workers/pdf/**`, `lib/reports/pdf-renderer.tsx`, or `lib/format/inr.ts`
  change (the renderer rarely moves — no point rebuilding it on every
  unrelated push).
- `deploy-staging.yml` (the main worker) fires on every `dev` push as
  before.
- The two workflows have separate concurrency groups, so a push that
  touches both deploys them in parallel.

## 4. Verify

```bash
# Sign in to staging, then hit the PDF route. A 200 with a PDF body
# means the binding + renderer are live:
#   https://consultway-ops-staging.mayuresh-dongare.workers.dev/dashboard/reports/pdf

# If something's off, tail the PDF worker's logs:
wrangler tail consultway-ops-pdf-staging
```

- **200 + PDF bytes** → working end-to-end.
- **503 "PDF reports are temporarily unavailable"** → the main worker
  couldn't reach the binding. Confirm step 1 ran and the main worker was
  re-deployed after.
- **500 "Failed to render report"** → the PDF worker threw mid-render.
  `wrangler tail consultway-ops-pdf-staging` shows the stack.

## Local development

Plain `pnpm dev` (Next dev server) has no `PDF_WORKER` binding, so the
PDF download degrades to a 503 — the same as the Day-30 stub. This is
expected; PDFs are verified two other ways:

1. **Unit tests** render the PDF in-process:
   `pnpm test --run lib/reports` (5 renderer tests).
2. **Staging** exercises the full binding path after deploy.

(Wiring service bindings into the local `pnpm preview` workerd is
possible but fiddly — deferred. Use the tests + staging for now.)

## Production

The production binding (`env.production.services` → `consultway-ops-pdf`)
is already declared in `wrangler.jsonc`, but production isn't live yet
(the main worker's `env.production.d1_databases.database_id` is still
`REPLACE_WITH_D1_UUID`). When production is provisioned, deploy the PDF
worker to prod first — same ordering rule:

```bash
pnpm deploy:pdf-worker:prod
#   → wrangler deploy --config workers/pdf/wrangler.jsonc --env production
```
