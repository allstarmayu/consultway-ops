# Layer A deploy — current status (paused mid-flight)

_As of Deploy Staging #10 (commit `679a642`)._

This file captures where the Layer A deploy effort stands, what's done,
what's left, and the architectural choice that needs your call before
the next attempt.

## The state of the world

### What's done ✅

- **Cloudflare resources provisioned** (all real, not placeholders):
  - D1 database: `consultway-staging` (uuid `901b2201-...3634a15ba197`)
  - KV namespaces: `SESSIONS` + `RATE_LIMITS`
  - R2 bucket: `consultway-docs-staging` with CORS allow-list applied
- **Secrets in Cloudflare** (set via `wrangler secret put --env staging`):
  - `JWT_SECRET`, `PASSWORD_PEPPER`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (=consultway-docs-staging)
- **GitHub Secrets:** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
- **GitHub Actions wired:** `.github/workflows/ci.yml` + `deploy-staging.yml`
- **Build adapter wired:** `@opennextjs/cloudflare@1.19.11` + `wrangler@4.95.0`
  installed; `open-next.config.ts` configured; `next.config.ts` dev hook in.
- **App code is deploy-clean:** the OpenNext bundle compiles successfully,
  D1 migrations apply against the remote staging DB, wrangler uploads
  all 80 static assets to Cloudflare's edge.

### The wall ❌

> **Your Worker exceeded the size limit of 3 MiB. Please upgrade to a
> paid plan to deploy Workers up to 10 MiB.**

The OpenNext-built worker is **14.5 MiB**. Cloudflare's caps:

| Plan | Worker size limit | Cost |
|---|---|---|
| Workers Free | 3 MiB | $0 |
| Workers Paid | 10 MiB | $5/mo |

So **even the Paid plan doesn't fit our current bundle**. Need to trim.

### Why the bundle is 14.5 MB

Top suspects (rough estimates, need actual analysis to confirm):

| Dep | Approx weight | Used in |
|---|---|---|
| `@react-pdf/renderer` | ~5-7 MB | `/dashboard/reports/pdf` |
| `recharts` + transitive d3 | ~1.5 MB | Dashboard + reports charts |
| Next.js runtime + Radix UI + Lucide + sonner + motion | ~5-6 MB | Everywhere |
| Our app code | ~1-2 MB | Everywhere |

The smoking-gun signal: a `Duplicate key "axisIndex"` warning during
the deploy log — that's from a font-parsing library bundled inside
`@react-pdf/renderer`, which alone is probably the biggest single
contributor.

## Tomorrow's decision

Three real options for closing the size gap:

### Option 1 — Workers Paid + targeted trim (Recommended)

- Upgrade to Workers Paid: dashboard → Workers & Pages → Plan tab → $5/mo
- Move `@react-pdf/renderer` out of the main worker bundle. Two ways:
  - **a)** Mark it `external` in `open-next.config.ts` and ship a
    separate dedicated PDF worker. Cleaner long-term.
  - **b)** Remove the `/dashboard/reports/pdf` route from staging
    entirely (gate behind a feature flag). Simpler for Layer A.
- Estimated time: 1-2 hours
- Result: ~9-10 MiB bundle, fits inside Paid limit

### Option 2 — Stay on Free, aggressive trim

- Drop PDFs entirely
- Drop recharts (would mean dropping the dashboard charts + the
  reports page's chart preview)
- Audit every other dep for size
- Estimated time: 3-4 hours
- Result: feasible but restricts what we can build forever after
- Trade-off: 3 MiB is genuinely tight for a modern Next app

### Option 3 — Re-platform to Vercel for the app, keep R2 on Cloudflare

- Vercel has no comparable size limit
- App runs on Vercel; R2 stays for documents/avatars
- Loses the "all-Cloudflare" simplicity
- Estimated time: ~1 day
- Best if you anticipate adding bigger features (AI integrations,
  larger libs) that would breach 10 MiB anyway

### My recommendation

**Option 1.** The whole codebase was designed around Cloudflare (D1
schema, R2 patterns, OpenNext config, wrangler.jsonc). Re-platforming
would discard a lot of intentional architecture. $5/mo is essentially
zero. 10 MiB ceiling is closable with one dep change.

## Strategic notes (read before deciding)

### Bundle headroom on Workers Paid

After externalizing `@react-pdf/renderer` we'll be ~9-10 MiB. That
leaves limited headroom for future features. Things that COULD push
us back over the limit:

- AI/LLM SDK integrations (`@anthropic-ai/sdk` is ~500 KB, OpenAI
  similar)
- Image processing libs (sharp, etc.) — but those are Node-only
  anyway, would need separate handling
- A second charting library
- A search index lib (e.g. fuse.js is small but lunr/minisearch are larger)

If the app's roadmap includes any of those, the 10 MiB ceiling may
bite again later. Vercel (Option 3) is the future-proof play; Cloudflare
(Option 1) is the right-now play.

### Strategic risk on the middleware path

Separately from the bundle-size issue, the deploy currently uses
`middleware.ts` with `runtime: 'experimental-edge'`. Both flags are
deprecated/experimental in Next 16. Next 17 could remove either. The
durable fallback (when the day comes) is dropping framework middleware
entirely and inlining `readSession()` checks at the top of each
`/dashboard/*` Server Component. ~15 minutes of mechanical work.
Flagged in `middleware.ts`'s module docstring.

## Where the work landed today

13 commits across this session — all on `origin/dev`:

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
```

All work is committed and pushed. Working tree is clean.

## Tomorrow's first move

Pick one of Option 1/2/3 above. If Option 1 (recommended):

1. Open the Cloudflare dashboard, upgrade to Workers Paid ($5/mo).
2. Tell me which way you want `@react-pdf/renderer` handled — external
   worker (1a) or feature-flag off staging (1b).
3. I'll do the bundle work, push, and Deploy Staging #11 should land
   green.

If Option 2 (Free + trim): more involved, I'll lay out the dep-audit
plan first.

If Option 3 (Vercel): half-day re-platforming session. I'll write a
migration plan first.

Either way, ping me in the next session with the call.
