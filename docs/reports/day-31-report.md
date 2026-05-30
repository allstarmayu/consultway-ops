# Day 31 — print-to-PDF, the @react-pdf WASM wall, and a save by smoke test

_Date: 2026-05-29_

## Scope

A focused-then-pivoted session. The plan was Day-30 follow-up #1
("Dedicated PDF worker") — half a day of muscle-memory deploy work to
restore `/dashboard/reports/pdf` by extracting `@react-pdf/renderer`
into a sibling `consultway-ops-pdf` worker called over a Cloudflare
service binding. The original renderer was preserved at commit
`679a642`; the path was meant to be: restore the renderer, dispatch via
service binding, wire the workflow, ship.

The first half of that plan executed cleanly. A `wrangler dev` smoke
test against a sample admin payload — the part the original Day-20 plan
called for ("benchmark `@react-pdf` vs headless Chromium on Day 20" —
never done) — surfaced TWO hard walls, in order:

1. **The browser-build trap.** `@react-pdf/renderer` has no `exports`
   field — it uses the legacy `browser` field, which maps the package
   entry to `react-pdf.browser.js` whose `renderToBuffer` is a literal
   throw-stub. Wrangler's esbuild honours `browser` because workerd
   advertises browser-ish conditions, so the worker bundle picked up the
   stub. Fixed in-session by aliasing to `@react-pdf/renderer/lib/react-pdf.min.js`
   (the minified node build) — not in the browser map, so the swap is
   sidestepped. POST /render then re-ran and surfaced wall #2.

2. **The Yoga-WASM wall.** The node build's layout engine
   (`yoga-layout@3`) instantiates WebAssembly from raw bytes at runtime.
   workerd forbids this (`CompileError: WebAssembly.instantiate(): Wasm
   code generation disallowed by embedder`). No compatibility flag
   relaxes it; the constraint exists for the same reason public Workers
   can't run arbitrary user-controlled WASM. Hard platform wall, not a
   bundling fix away.

That finding ended the @react-pdf path on Cloudflare permanently. The
right move was to **stop, preserve the work, and pivot to a free,
durable approach** — browser-side `window.print()` against a print
stylesheet. That's what shipped.

End-of-day state: the Day-31 PDF spike preserved on
`spike/pdf-react-worker` (8 commits worth of work + the WASM finding
documented in the commit body); `dev` advanced to `cd120d9` with the
print-to-PDF feature live on staging; staging deploy green; net **−347
LOC across `dev`** (broken route + orphan stub + skipped tests gone).

## What shipped

### Item L — PDF worker spike (preserved, not on `dev`)

Branch: `spike/pdf-react-worker` (origin tracking, commit `58823e1`).
This is the Day-30-follow-up-#1 work, taken to the point where two
distinct platform walls became evident — then archived rather than
fought through.

Contents:
- `lib/reports/pdf-renderer.tsx` — renderer restored from `679a642`,
  imports refactored to relative paths (`../format/inr`, `../db/schema`)
  to sidestep `@/` alias-resolution fragility across the wrangler /
  Next dual-bundling boundary.
- `lib/reports/pdf.tsx` rewritten as a runtime dispatcher: in a Worker,
  calls `env.PDF_WORKER.fetch(...)` via Cloudflare service binding; in
  Node/local-dev, dynamic-imports the renderer directly. Re-exports
  `ReportPdfInput`. Augments `CloudflareEnv` with `PDF_WORKER?: unknown`
  (same pattern as the Day-30 D1 binding type augmentation).
- `workers/pdf/` — sibling worker:
  - `wrangler.jsonc`: `consultway-ops-pdf` (+ `-staging` env), `workers_dev: false`
    (binding-only access, no public URL), `nodejs_compat`, observability on. Top-
    level + env blocks duplicated (same wrangler vars/kv non-inheritance
    caution as Day 30). The `alias` map → `react-pdf.min.js` was added
    after smoke-test #1.
  - `src/index.ts`: minimal `fetch` handler — `GET /health` returns
    `{status:"ok",worker:"consultway-ops-pdf"}`; `POST /render` JSON-decodes
    the input, rehydrates `generatedAt`, calls `renderReportPdf`, returns
    bytes with `Content-Type: application/pdf`; bad JSON → 400, bad
    method/path → 404, render throw → 500 with structured log.
  - `tsconfig.json` extending root.
- `wrangler.jsonc` (main) — service binding `PDF_WORKER` added to
  `env.staging` + `env.production`.
- `.github/workflows/deploy-pdf-staging.yml` — mirror of Day-30's deploy
  workflow shape, scoped to `workers/pdf/` path filter.
- `docs/DEPLOY_PDF_WORKER.md` — operator checklist for the
  PDF-worker-first deploy sequence.
- `lib/reports/__tests__/pdf.test.ts` — re-pointed to import from
  `pdf-renderer`, un-skipped.

The spike's value isn't the code (the platform won't run it); it's the
documented finding. The commit body captures both walls precisely so
the next person who's tempted by `@react-pdf` on Workers (or
`yoga-layout@3` for anything else) doesn't have to repeat the
smoke-test discovery cycle. The path forward, when PDF reports are
prioritised, is the Day-20 plan's listed fallback: **Cloudflare Browser
Rendering** against the HTML report (Cloudflare-native, no WASM, likely
free at this volume).

### Item P — Client-side print-to-PDF (shipped on `dev`, live on staging)

Commit: `cd120d9`. Replaces the broken `/dashboard/reports/pdf` server
route with `window.print()` + a print stylesheet. Free, durable, no
infra, no cost, no platform dependency.

Why this is "fix once and for all" — the constraints were genuinely:
*(a) free* (not "probably within an allowance") and *(b) permanent*
(nothing to break later). Browser Rendering meets (b) but (a) is
allowance-dependent. Print stylesheet meets both **unconditionally** —
the rendering happens in the user's own browser, zero Cloudflare
services involved, no Cloudflare can change anything that breaks it.
The single trade-off it makes is "user must click" — `window.print()`
can't generate PDFs headlessly. The current spec doesn't ask for that
("PDFs are generated on-demand, streamed back to the client" — Day-20
acceptance criteria), so the trade is free.

What landed:

- `app/dashboard/reports/_components/print-report-button.tsx` (NEW) —
  client `"use client"` button. Sets `document.title` to
  `consultway-report-<from>_<to>` so the saved PDF gets a meaningful
  default filename, calls `window.print()`, restores the title on
  `afterprint`. Uses the existing `Download` lucide icon and shadcn
  `Button` outline variant.

- `app/dashboard/reports/page.tsx` — swapped the dead `<Link href={pdfHref}>`
  for `<PrintReportButton from={start} to={end} />`. Added a print-only
  branded cover (`hidden print:block`) above the screen header: brand
  eyebrow, "Operations & Financial Summary" title, a metadata line
  (period · scope · generated UTC). Marked the screen `<PageHeader>` and
  the filter pickers row with `print:hidden` (PageHeader accepts
  `className`). Wrapped the page content in `<div data-print-region>`
  to scope the print stylesheet's overrides. Removed the now-dead
  `buildPdfHref` helper.

- `app/globals.css` — appended a `@media print` block at the end of the
  file:
  1. Re-declares the **core warm-ambient (light) palette tokens** at
     `:root` inside `@media print`. Values copied verbatim from the
     default `:root` block above (not invented hex). Comes last in
     source order, so it wins over `[data-theme="midnight-espresso"]`
     and the other dark themes — printing a dark theme still comes out
     ink-friendly.
  2. Hides app chrome: `[data-dashboard-root] > :not(main)` (the
     desktop sidebar, without coupling to its internals) and
     `[data-print-hide]` (anything explicitly marked). Resets `main`'s
     scroll + the content-wrapper's `max-width` + screen padding so
     the report uses the `@page` margins.
  3. `[data-print-region] [data-slot="card"] { break-inside: avoid }`
     keeps each card whole across pages; `break-after: avoid` on
     headings prevents stranded titles. `box-shadow: none` strips
     screen shadows.
  4. `@page { size: A4; margin: 14mm }` at the top level.

- `app/dashboard/layout.tsx` — wrapped the `<MobileSidebar>` usage in
  `<div data-print-hide>`. Print media is roughly A4 width (sub-`lg`),
  so the mobile bar's own `lg:hidden` would otherwise show it on the
  printed page; the marker pre-empts that.

- `app/dashboard/reports/pdf/route.ts` — **deleted.** The server PDF
  route is gone for good. Future automation-only PDF needs (a
  hypothetical cron that emails monthly reports) would use Cloudflare
  Browser Rendering at that point — not a Worker-side renderer.

- `lib/reports/pdf.tsx` and `lib/reports/__tests__/pdf.test.ts` —
  **deleted.** Once the route was gone, the Day-30 stub and its 5
  skipped tests had no real consumer; they were tracking an abandoned
  approach.

Net: −347 LOC across the print-feature commit.

**Manual verification flagged:** I can't render print output. Mayuresh
to sign in on staging, hit `/dashboard/reports`, click "Download PDF",
*Save as PDF*. Check: sidebar/filters hidden, branded cover present,
cards intact across pages, filename dated. Try Midnight Espresso theme
too — should still print light/ink-friendly. Faint borders or awkward
page breaks would be a one-line palette tweak in the `@media print` block.

### Item U — Mayuresh metadata seed (drafted, deferred)

`scripts/seed-staging-mayuresh-metadata.sql` — an idempotent SQL file
that populates the staging admin (`mayuresh.dongare@outlook.com`,
UUID `9077d1b9-3943-4187-b8bd-ec683199cde2`) with realistic profile
metadata: `phone`, `job_title`, `email_verified_at`, plus a full
`user_preferences` row (theme/density/motion + all email-notification
toggles). Uses `ON CONFLICT(user_id) DO UPDATE` for safe re-runs.
Delivered the Day-30 way (`--file`, not `--command`, to dodge
PowerShell's `$` expansion).

Deferred for coherence — Mayuresh asked for "the entire dashboard
data" comprehension after the initial single-user metadata ask, and
the right answer is to bundle the user-row seed with the comprehensive
entity seed (Phase B) tomorrow. The SQL stays on disk as a Day-32
input.

## Key decisions

**Smoke test was the right first move; saved a real shipping bug.** I
could have skipped the local `wrangler dev` step and trusted the spike
would work in production based on tsc + build passing. The Day-30
runbook didn't include local smoke tests at all (we deployed and
watched). For this PDF feature, smoke testing locally caught both
platform walls in ~30 minutes vs. discovering them on a staging deploy
and reading `wrangler tail`. The cost of `wrangler dev` for a small
isolated worker is ~10s to start and ~1s to render — pay it. Standardize
this for any Worker that hosts a meaningfully different runtime
(anything pulling node-leaning deps, anything with WASM, anything
non-trivial in the `fetch` handler).

**Pivot tactically, not just retreat.** When wall #2 surfaced, the
binary choice was (a) chase a Container/Browser-Rendering path to
salvage the server-PDF feature, or (b) revisit whether the feature
needed server PDFs at all. (b) is what reframed it: the data already
exists as an HTML report, the spec says "on-demand, streamed back to
the client," and the user's *actual* requirement was a downloadable
branded PDF — not a server-generated byte stream. `window.print()`
delivers the requirement with literally zero infra. Spec re-reading
beat infra-tunnel-vision.

**Preserve the spike on a branch with a thorough commit body.** Could
have just `git restore`-d the uncommitted spike and discarded. Instead:
~1 hour of careful work + the WASM finding survives on
`spike/pdf-react-worker`, the commit body explains BOTH walls precisely,
and the original renderer's path to a future Cloudflare-Container or
Browser-Rendering shape is unblocked. Cost: one extra branch and a
five-minute push. Benefit: future-me (or future Mayuresh) doesn't repeat
the discovery cycle.

**Re-declare the warm-ambient palette inside `@media print` rather than
chase per-utility overrides.** The dashboard ships 6 themes, several
dark. Forcing print to be ink-friendly via per-rule `background: white !important`
sprinkled across utilities would have been brittle. Re-declaring the
six core tokens at `:root` inside `@media print` means every Tailwind
token utility (`bg-card`, `text-foreground`, `border-border`,
`text-accent`) resolves to a print-safe value automatically, regardless
of active theme. The values copied are exact warm-ambient palette
values from the default `:root` block above — no invented hex. Comes
last in source order so the theme-class selectors `[data-theme="..."]`
lose to it by cascade.

**Use relative imports in `pdf-renderer.tsx` (the spike), not the `@/`
alias.** The renderer is bundled by TWO toolchains in the spike — Next/
OpenNext (for the dispatcher's dev fallback) and wrangler's standalone
esbuild (for the PDF worker, with a different tsconfig). Alias
resolution across the `tsconfig extends` boundary is fragile under
wrangler. Relative paths (`../format/inr`) resolve identically under
both bundlers. The deviation from the codebase's `@/` convention is
justified in the file's import comment.

**Defer the comprehensive staging fixtures (Phase B) to a fresh
session.** Mayuresh's "add metadata to the account" widened into "the
entire dashboard data ... test each and every functionality" — a real
~1–1.5 hr block that's the deferred Day-21 #2 follow-up
("Realistic Indian-flavoured fixture data") extended for remote D1.
Doing it tonight at the tail of a print-feature session would risk a
rushed dump-script. A fresh start tomorrow with the full plan
(`scripts/dump-staging-fixtures.ts` → emits `seed-staging-fixtures.sql`
→ ships via `wrangler d1 execute --file`) is the right shape.

## Gotchas surfaced

**Cloudflare workerd disallows runtime WebAssembly compilation.** Any
package that calls `WebAssembly.instantiate(<rawBytes>)` at module load
or in a hot path will fail with `CompileError: Wasm code generation
disallowed by embedder`. `yoga-layout@3` does this for `@react-pdf/renderer`.
Other affected: `@swc/wasm`, `esbuild-wasm`, anything using a runtime
WASM template. The constraint applies to public Workers regardless of
Workers Paid/Free or `nodejs_compat`. The exemption pathway (a private
"workers-bundle-runtime-wasm" flag) is per-deal with Cloudflare, not a
public knob. For PDF generation specifically, this means:
`@react-pdf/renderer` (Yoga WASM) → out; `pdf-lib` → in (pure JS).
For other rendering / image / wasm-heavy work: assume WASM at runtime
is out unless validated by smoke test.

**The `@react-pdf/renderer` browser-field trap.** No `exports` field;
uses the legacy `browser` field `{"./lib/react-pdf.js": "./lib/react-pdf.browser.js"}`.
esbuild honours `browser` when packing for workerd → bundle picks up the
*browser* build whose `renderToBuffer` is a throw-stub
(`"renderToBuffer is a Node specific API"`). Fix: wrangler `alias`
mapped to `@react-pdf/renderer/lib/react-pdf.min.js` (the minified node
build — NOT in the browser map, so the swap is sidestepped). Documented
inline in `workers/pdf/wrangler.jsonc`. Would have shipped a broken
worker if the smoke test hadn't caught it.

**Wrangler `alias` may not inherit into `env.*` blocks.** Same caution
as Day-30's `vars` + `kv_namespaces` non-inheritance — duplicated the
`alias` block into both `env.staging` and `env.production` defensively.
Not formally verified for `alias` but the cost of duplication is
trivial vs. the cost of a deploy that bundles the browser stub.

**Stale `.next/dev/types/validator.ts` survives `next build`.** `next
build` regenerates `.next/types/*` but not `.next/dev/types/*` (left
behind by a prior `next dev` session). The project tsconfig `include`s
both globs, so `tsc --noEmit` and `next build`'s type-check phase both
trip on a stale validator referencing a route file you've just deleted.
Looks like a real type error; isn't. Fix: `rm -rf .next/dev` before
running tsc/build after deleting a route. CI doesn't hit this (no prior
dev run there). Worth a `.gitignore`-adjacent cleanup hook eventually.

**`window.print()` saved-filename comes from `document.title`.** The
default save-as filename is the current document title. Set it
*before* calling `print()` and restore on `afterprint`. `print()` is
synchronous in most browsers (blocks until the dialog is dismissed),
but the listener is belt-and-suspenders for the async cases. The
restore listener removes itself in the same call (one-shot subscribe).

**MobileSidebar would leak into print PDFs without an explicit hide.**
Print media is rendered at the page width (~794 CSS px at 96 dpi for
A4), which is below the `lg` Tailwind breakpoint (1024 px). So
`lg:hidden` on `MobileSidebar`'s root means the bar IS visible at print
width. The fix: a `<div data-print-hide>` wrapper in the dashboard
layout, with `[data-print-hide] { display: none !important }` in the
print stylesheet. Cheap; the wrapper is a harmless empty block at lg+
where MobileSidebar's own `lg:hidden` already hides its content.

**`gh` CLI isn't installed in this Git Bash environment.** A `gh run
watch` invocation silently failed (`command not found`) but the
trailing curl in the same script exited cleanly, so the bash exit code
was 0 — the watch appeared to succeed and didn't. Used GitHub's public
API via curl + node directly to poll workflow status instead. Worth
remembering: anything that wants `gh` needs an `which gh` precheck or a
direct-API fallback.

## Surfaces touched

Print-to-PDF feature (committed on `dev` as `cd120d9`):

```
app/dashboard/reports/_components/print-report-button.tsx  (NEW — client print button)
app/dashboard/reports/page.tsx                              (modified — print button + cover + print:hidden)
app/dashboard/reports/pdf/route.ts                          (DELETED — broken server route)
app/dashboard/layout.tsx                                    (modified — MobileSidebar print-hide wrapper)
app/globals.css                                             (modified — @media print block + @page A4)
lib/reports/pdf.tsx                                         (DELETED — orphan stub)
lib/reports/__tests__/pdf.test.ts                           (DELETED — orphan skipped tests)
docs/reports/day-31-report.md                               (NEW — this file)
```

PDF-worker spike (preserved on `spike/pdf-react-worker` as `58823e1`):

```
lib/reports/pdf-renderer.tsx                                (NEW — renderer restored)
lib/reports/pdf.tsx                                         (modified — dispatcher with service binding)
lib/reports/__tests__/pdf.test.ts                           (modified — un-skipped, points at pdf-renderer)
workers/pdf/wrangler.jsonc                                  (NEW — sibling worker config + alias fix)
workers/pdf/src/index.ts                                    (NEW — fetch handler)
workers/pdf/tsconfig.json                                   (NEW — extends root)
wrangler.jsonc                                              (modified — service binding to PDF_WORKER)
package.json                                                (modified — build:pdf-worker, deploy:pdf-worker scripts)
.github/workflows/deploy-pdf-staging.yml                    (NEW — worker deploy workflow)
docs/DEPLOY_PDF_WORKER.md                                   (NEW — operator checklist)
app/dashboard/reports/pdf/route.ts                          (modified — drops 503 stub fallback)
```

Pending on disk (untracked, will land in Day 32 Phase B):

```
scripts/seed-staging-mayuresh-metadata.sql                  (drafted — Mayuresh's profile + preferences)
```

## Test totals

Before Day 31: **683 passing + 5 skipped across 37 files** (Day 30 end).
After Day 31 on `dev`: **683 passing + 0 skipped across 36 files**.

The 5 skipped PDF render tests moved with their renderer to the spike
branch (where they're un-skipped); on `dev` the orphan test file was
deleted. Net effect on `dev`: −1 test file, −5 skipped tests, 0 change
in pass count. The Day-30 skipped `lib/preferences/__tests__/server.test.ts`
case still skipped — its Proxy-incompatible spy fix remains a follow-up.

`pnpm exec tsc --noEmit` clean after deleting `.next/dev` artifacts.
`next build` green; `/dashboard/reports/pdf` confirmed absent from the
route table; `/dashboard/reports` intact.

## Live URL + auth

Layer A staging (unchanged URLs, advanced to `cd120d9`):
- **URL**: https://consultway-ops-staging.mayuresh-dongare.workers.dev
- **Health**: 200 OK with the new commit sha live
- **Sign-in**: same two admins (Mayuresh Dongare, Purva Tare)
- **Print-to-PDF**: live on `/dashboard/reports` → "Download PDF"
- **GitHub Actions deploy**: completed successfully for `cd120d9`
  ([run 26671568406](https://github.com/allstarmayu/consultway-ops/actions/runs/26671568406))

Manual print-preview verification by Mayuresh: pending. No urgency —
faint-border / page-break tweaks are one-line if anything reads off.

## Followups for Day 32+

**Top of queue — specifically teed up tonight:**

1. **Phase B: comprehensive staging fixtures (medium scale)**. The
   deferred Day-21 #2 ("Realistic Indian-flavoured fixture data")
   extended for remote D1. Build `scripts/dump-staging-fixtures.ts` —
   spins up a SCRATCH SQLite under `.wrangler/seed-dump-source.sqlite`
   (your normal dev DB untouched), applies migrations, runs `scripts/seed.ts`
   at `SEED_SCALE=medium` (~15 companies / 60 docs / 12 tenders / 30
   apps / 12 projects / 120 transactions), then reads each entity table
   via better-sqlite3 and emits `scripts/seed-staging-fixtures.sql`
   with `INSERT ... ON CONFLICT DO NOTHING` so re-runs are no-ops. Ship
   via `wrangler d1 execute consultway-staging --remote --env staging
   --file scripts/seed-staging-fixtures.sql`. Then run the
   already-drafted `scripts/seed-staging-mayuresh-metadata.sql`. Verify
   each entity surface on staging (companies list, tender list, projects
   board, reports dashboard, transactions). ~1–1.5 hr.

2. **Phase B follow-up: R2 fixture uploads.** Seeded documents reference
   R2 fileKeys that don't exist on staging — listings/filters/search
   work, but actual file downloads 404. Upload a small set of placeholder
   PDFs to staging R2 matching the seeded keys so the download flow is
   end-to-end testable. ~30 min.

3. **Stale config cleanup (touches protected files — needs your OK
   per CLAUDE.md):**
   - Drop `serverExternalPackages: ["@react-pdf/renderer"]` from
     `next.config.ts` (dead since the print pivot).
   - Remove `@react-pdf/renderer` from `package.json` dependencies
     (unused on `dev`; the spike branch keeps it via its own
     `package.json`).
   - Tombstone or delete `docs/DEPLOY_LAYER_A_STATUS.md` (stale —
     predates the Day-30 Layer A success).
   ~15 min once approved.

4. **Manual print-preview check** (you, when convenient). One-line
   palette tweak available if borders/muted text look too faint on
   paper.

**From this session's spike, NOT on `dev`:**

5. **PDF reports via Cloudflare Browser Rendering** (when the feature
   re-prioritises). The Day-20 plan's listed fallback. Cloudflare-native,
   no WASM, likely within Workers Paid's included allowance. Build:
   a worker with a Browser binding, server-render the report HTML +
   feed via `page.setContent()`, return `page.pdf()`. Don't navigate
   to an authenticated URL — render the HTML standalone so no session
   round-trip is needed. The print-CSS work tonight is a partial gift
   to that future task: it already proves the report has a
   print-friendly HTML shape, so the Browser Rendering page just uses
   `@media print` automatically.

**Carried forward from earlier days (unchanged):**

6. Cron handler wiring (Day-30 #4). The 3 cron triggers in
   `wrangler.jsonc` fire daily but reach no handler — OpenNext config
   deliberately doesn't re-export `scheduled`. Wire via entry/worker
   override mechanism. 1-2 hr. Folds naturally into the G small-wins
   bundle.

7. In-app user management UI (Day-30 #2). `/dashboard/admin/users`
   with list + Invite forms. Half day. Pairs with Resend (8).

8. Resend domain verification (Day-30 #3). User-side DNS work +
   `wrangler secret put RESEND_API_KEY`. Unlocks real email for
   registration / password reset / invites / Phase 2 email-change flow.
   ~30-45 min code + your DNS time.

9. `lib/preferences/__tests__/server.test.ts` Proxy-compatible spy fix
   (Day-30 #5). ~20 min.

10. Bundle-size monitoring CI step (Day-30 #7). ~30 min.

11. Doc rewrite sweep (Day-30 #6). Especially `docs/04-architecture.md`,
    `docs/05-database-schema.md`, `docs/06-api-reference.md` —
    they've drifted across the Day-26 → Day-31 era. ~1-2 hr.

12. Drop framework middleware → inline `readSession()` checks
    (Day-30 #8). Defer until Next 17 actually deprecates
    `experimental-edge`.

13. Cmd+K command palette (Day-26 #6). Half day. Needs cmdk dep.

14. Email-change flow (Day-27 #2). Pair with (7) + (8).

15. Organizations table + Org section persistence (Day-26 #4 /
    Day-25 #2).

16. 2FA enrolment (Day-25 #4).

17. Real "active sessions" list (Day-25 #5).

18-24. The long tail from Day 30 carried forward unchanged.

## Carry-forward to Day 32

- **Print-to-PDF is the active answer for `/dashboard/reports`**.
  Server-side PDF generation is OFF the table for `@react-pdf`
  permanently; Browser Rendering is the next-eligible path when the
  feature is reprioritised, but the on-demand HTML+print contract may
  cover the actual requirement indefinitely. Don't reach for a
  server-side PDF renderer without re-reading the Day-31 commit on
  `spike/pdf-react-worker` first.

- **`spike/pdf-react-worker` exists on origin.** Don't merge it into
  `dev`. Its purpose is the documented finding, not the code. If a
  Cloudflare-Container or Browser-Rendering PDF path is built, the
  spike's renderer is the starting point — restore from `679a642` or
  cherry-pick from the spike.

- **`scripts/seed-staging-mayuresh-metadata.sql` is staged on disk
  (untracked)**. Will run as part of Day-32 Phase B, alongside the
  comprehensive fixtures. Don't `rm` it.

- **Day-32 Phase B is the top priority** unless something hotter
  surfaces. Mayuresh explicitly chose "next session" for it. Scale
  decision (medium) + R2 follow-up queue already locked.

- **Staging is at `cd120d9`**, deployed at 02:10 UTC, health green.
  GitHub Actions on autopilot for every push to `dev` as before.

- **CLAUDE.md hard rules still hold** on package.json / next.config.ts
  / wrangler.jsonc deletions and dep changes. The stale-config cleanup
  bundle (3 above) needs explicit OK each time, not a blanket "go".

A focused day. The smoke-test catch was the high-leverage moment —
without it we'd have shipped a 500-returning PDF worker to staging and
discovered Yoga-WASM via `wrangler tail`, an hour of avoidable debug.
Standardising the local-smoke-test step for any Worker with a non-trivial
runtime is the durable lesson. Spike preserved. Feature shipped. Day 32
loaded for Phase B.
