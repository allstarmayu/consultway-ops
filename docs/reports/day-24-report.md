# Day 24 — Compliance loop closure + dashboard charts + animation pass

_Date: 2026-05-23_

## Scope

Ten committed deliverable chunks across three coherent threads —
closing the Day-23 compliance followups, building the dashboard +
reports visualisation surface from scratch, and laying a shared
animation foundation under everything that landed. Same calendar
day as Day 22 / 23 because the work compressed into one long session.

1. **Compliance loop closure (followups #1 + #4 from Day 23).** The
   widened-union + state-machine work from Day 23 left two
   user-visible gaps: the company edit form didn't surface
   `rejectionReason`, and there was no per-status transition button
   panel — admins had to use the catch-all edit form to change
   compliance state. Both closed in this session.

2. **Dashboard + reports charts and KPIs (Figma-aligned).** The
   volume-lifted seed from Day 22 finally has visualisations to live
   against. Three new charts (12-month transactions trend area,
   per-month transactions bar, status distribution donuts), four new
   financial / company-count aggregates, a refreshed KPI strip on the
   admin dashboard, URL-driven filters on the trend chart, a Quick
   Actions row at the bottom, and the same vocabulary applied to the
   `/dashboard/reports` page (KPI strip + donut summaries).

3. **Chart library polish + animation pass.** Two refinement chunks:
   first, rewriting all three charts on the official shadcn/ui chart
   primitives for palette-cohesive theming and card-shaped tooltips;
   second, a CSS-only animation foundation (`stagger-children`,
   `interactive-card`, `animate-fade-up`) applied across every card
   on the dashboard + reports, with chart entrance animations
   re-enabled and `prefers-reduced-motion` honoured.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 636/636 green (was 592; +44 across new aggregate +
state-machine + action-layer test files); `pnpm db:seed` re-run
against the existing DB → every row `unchanged`; `pnpm seed:verify`
clean; `pnpm build` clean. The new chart components + animation
utilities only render on admin/staff surfaces — no impact on the
company-role UX.

A runtime bug surfaced mid-session (commit `41711f9`): the trend-
filter URL-param resolvers were co-located with a `"use client"`
component, which Next.js rightly refuses to let a Server Component
call. Fix: extract the resolvers into a sibling non-"use-client"
module. Caught only by `pnpm dev` (not `pnpm build`, since the
dashboard is dynamically rendered); see Gotchas below.

## What shipped

### Chunk 1 — Editable `rejectionReason` on the edit form (commit `21de823`)

**Form field.** `components/companies/company-form.tsx` picks up a new
admin/staff-only "Rejection reason" section, conditionally rendered
when `isEditMode && (viewerRole === "admin" || "staff") &&
initialValues.complianceStatus === "rejected"`. Required textarea
when shown — client-side resolver mirrors the server's superRefine
("rejected ⇒ reason"), inline error fires on blur.

**Form-state plumbing.** The form's RHF generic widened from
`CreateCompanyInput` to `CreateCompanyInput & { rejectionReason:
string | null }`. The Zod resolver runs `createCompanySchema.safeParse`
(which strips the unknown `rejectionReason` field) and then re-merges
the raw value back into the resolver's return so RHF keeps it in its
state. Submit branches split the field out before calling
`updateCompany` — create-mode submits stay unchanged.

**Back-door guard.** New cross-field check in
`lib/companies/actions.ts::updateCompany`: if `existing.complianceStatus
=== "rejected"` AND the patch tries to clear `rejectionReason` to
null/empty, the action returns `{ ok: false, field: "rejectionReason" }`.
Day-23's schema superRefine only catches the "moving INTO rejected
without a reason" half; this guard closes the inverse direction — a
malicious or buggy client clearing the reason on an already-rejected
row no longer corrupts the seed invariant.

**Tests (+3, 592 → 595).** `lib/companies/__tests__/actions.test.ts`
covers the new guard (null clear, whitespace-only clear, happy-path
admin reason update).

Page wiring: `app/dashboard/companies/[id]/edit/page.tsx` and
`app/dashboard/companies/new/page.tsx` both pass `viewerRole={session.role}`
to `<CompanyForm>`.

### Chunk 2 — Per-status transition panel (commit `0bad769`)

**State-machine helpers.** `lib/companies/state-machine.ts` gains
`legalNextStatuses(from)` + `hasAnyLegalComplianceTransition(status)`
— mirrors `lib/projects/state-machine.ts`'s API. Drives the panel's
"only render buttons for legal next states" logic.

**New Server Action.** `transitionComplianceStatus(rawInput)` in
`lib/companies/actions.ts`:

  - Admin/staff only (RBAC at the function level)
  - Validates against `transitionComplianceStatusSchema` (new in
    `schemas.ts`) — rejected ⇒ min-5-char reason required
  - Loads the existing row, short-circuits on same-state target
  - State-machine assertion via `assertTransitionCompliance`
  - Writes complianceStatus always; writes rejectionReason ONLY on
    a transition INTO rejected (out-of-rejected transitions preserve
    the historical reason for audit context)
  - Emits the `compliance_status_changed` audit verb with full
    before/after snapshots + `metadata.statusChange + reason`

**Panel UI.** New
`app/dashboard/companies/[id]/_components/compliance-transition-panel.tsx`
(Client Component). Renders one button per legal next status, each
wrapped in a `<ConfirmDialog>`:

  - `compliant` / `non_compliant` / `expired`: single-click (no
    reason captured — routine moves, easily reverted)
  - `suspended`: `reasonField="optional"` (admins usually have
    context but the reason often lives in side channels)
  - `rejected`: `reasonField="required"` with destructive variant
    + 5-char minimum (mirrors the server schema)

Sits below the overview card on the company detail page; renders
nothing for terminal `rejected` rows (`legalNextStatuses("rejected")
=== []`); gated to admin/staff at the page level.

**Tests (+20, 595 → 615).** 7 new state-machine tests cover
`legalNextStatuses` cell-by-cell + the never-includes-self
invariant. 13 new action tests cover RBAC (unauth + company-role),
no-op short-circuit (no audit row written), illegal transitions
(terminal rejected + compliant→pending), legal transitions (verb +
metadata + reason on suspended→compliant), the rejected
requires-reason gate (missing / too-short / valid), and the
missing-row case.

### Chunk 3 — Transactions trend + per-month bar charts (commit `16e6e11`)

**New dep**: `recharts ^3.8.1` — first chart library on the project.
Loaded only on admin / reports renders since the chart components
are isolated.

**New aggregates** in `lib/dashboard/aggregates.ts`:

  - `getMonthlyTransactionsTrend({ months = 12 })` — admin only.
    Rolling N-month window ending at current month (UTC). Single
    `groupBy(substr(occurred_on, 1, 7))` aggregate; zero-fills every
    month in the window so the chart axis stays consistent.
  - `getMonthlyTransactionsBreakdownForPeriod({ start, end, companyId? })`
    — same shape but period-bounded.

Both return `{ months: [{ month, totalPaise, count }], start, end }`.

**Two new chart components:**

  - `app/dashboard/_components/transactions-trend-chart.tsx` —
    recharts `<AreaChart>` with a gradient fill below the curve.
    Renders inside a Server Component card (`transactions-trend-card.tsx`)
    that handles the empty state.
  - `app/dashboard/reports/_components/transactions-breakdown-bar-chart.tsx`
    — recharts `<BarChart>`. Embedded as a sibling inside the
    existing `TransactionsSummaryCard` (renders only when the
    selected window spans 2+ months).

Both charts use CSS-variable colours (`var(--color-primary)`,
`var(--color-border)`, etc.) so they pick up the warm-ambient theme
without hard-coded hex.

**Tests (+8, 615 → 623).** Cover the new aggregates' zero-fill,
ordering, RBAC × 2 callers, period bounds, and companyId narrowing.

### Chunk 4 — Financial KPIs + Total Companies card (commit `786a4f7`)

**Three more aggregates** in `lib/dashboard/aggregates.ts`:

  - `getCompanyCount({ withDeltaDays = 30 })` — admin/staff. Total
    + recent-additions delta (for the "+N in last 30 days" hint).
  - `getTotalProjectValue(scope?)` — admin only. Sum of
    `projects.budgetInr` (whole rupees per the Day-12 schema
    decision) — drives the "Total project value" card.
  - `getPaidAndDueTotals(scope?)` — admin only. Single
    `groupBy(type)` scan yielding paid = sum(payment), invoiced =
    sum(invoice), due = `max(0, invoiced − paid)`.

**KPI strip refresh** in `app/dashboard/page.tsx`:

  - Admin (top row): Total Companies / Total Projects / Total
    Project Value / Amount Paid (with "₹X due" hint). Second strip-row
    below carries Transactions This Month + Total Tenders.
  - Staff (4 cards): Total Companies / Total Projects / Total
    Tenders / Transactions This Month. Financial cards are admin-only.
  - Company-role: unchanged.

**New formatter** in `lib/format/inr.ts::formatInrCompact()` —
bucket-formats whole rupees into "₹ X.XX Cr" / "₹ X.XX L" /
"₹ X,XXX" so the KPI strip can show "₹ 18.50 Cr" instead of
"₹ 18,50,00,000".

**Tests (+10, 623 → 633).** 3 cover `getCompanyCount` (default
window + delta + old-row exclusion); 4 cover `getTotalProjectValue`
(unscoped + companyId narrow + zero state + RBAC); 3 cover
`getPaidAndDueTotals` (math + due clamp + RBAC).

### Chunk 5 — Status donut charts (commit `61c97bc`)

New `app/dashboard/_components/status-donut-chart.tsx` — pure
presentation Client Component. Takes a `{ key, label, count, color
}[]` slice array and renders a recharts `<PieChart>` with an
inner-radius donut. Domain-agnostic — projects, tenders, anything
with a closed-set status enum can drive it.

`StatusBreakdownCard` extends with a new optional `donut` prop. When
set, the card lays out a 180px chart on the left and the existing
rows-of-counts list on the right (stacks vertically on small
screens). Items pick up optional `color` + `donutLabel` fields —
only consulted when `donut={true}`. Backwards-compatible with the
two existing dashboard call sites.

Wired into Projects-by-status and Tenders-by-status cards on the
dashboard for admin/staff and company-role views. Slice colours
pull from the warm-ambient `--chart-1..5` tokens already defined in
`app/globals.css` — no new palette.

No new tests — pure UI.

### Chunk 6 — URL-driven filters on the trend chart (commit `062dc1b`)

`getMonthlyTransactionsTrend` picks up an optional `transactionType`
filter ("all" / one of the 5 types). "all" stays identical to absent
— same cross-type behaviour as before.

New `<TrendFilters />` Client Component composes:

  - A pill toggle group for window size: 6 / 12 / 24 months
  - A `<Select>` dropdown for transaction type

Both update the URL via `router.replace({ scroll: false })` wrapped
in `useTransition` so the page re-resolves the server aggregates
without losing scroll position. URL params: `?trendMonths=` /
`?trendType=` (defaults dropped so the URL stays clean on the
common case).

`<TransactionsTrendCard>` accepts `months` + `type` props (from
URL-resolved values) and forwards to the aggregate.

**Tests (+3, 633 → 636).** Cover the default echo ("all"),
narrowing (invoice-only sum < cross-type sum + correct count), and
the schema's rejection of bogus type values.

### Chunk 7 — Quick Actions row (commit `0a1400a`)

New `app/dashboard/_components/quick-actions-bar.tsx` — Server
Component card with role-gated CTAs at the bottom of the dashboard:

  - admin: Add Company / Add Tender / Add Project / Add Transaction /
    View Reports
  - staff: same minus Add Transaction (transactions are admin-only)
  - company-role: not rendered

Mirrors the Figma 01-dashboard reference. Leftmost button (Add
Company) gets the filled primary variant; the rest are outline.

### Chunk 8 — Bug fix: "use client" boundary (commit `41711f9`)

**Bug**: the trend-filter URL-param resolvers (`resolveTrendMonths`,
`resolveTrendType`) were exported from `trend-filters.tsx`, which
carries `"use client"`. The dashboard page (Server Component) called
them at request time, which Next.js rightly refuses:

  > Attempted to call resolveTrendMonths() from the server but
  > resolveTrendMonths is on the client.

`pnpm build` didn't catch this because the dashboard is dynamically
rendered (cookie-gated session) — the prerender pass never executes
the page.

**Fix**: extract the type definitions (`TrendType`, `MonthOption`),
constants (`MONTH_OPTIONS`, `TYPE_OPTIONS`), and resolver functions
into a new non-client module — `trend-filters-config.ts` — that both
sides import from. `trend-filters.tsx` keeps the React component
and re-exports `TrendType` for backwards compat (the trend card
imports it from there). The dashboard page swaps its resolver import
to the new config module.

### Chunk 9 — Rewrite charts on shadcn/ui chart primitives (commit `3af9bb0`)

Added the official shadcn chart wrapper via `pnpm exec shadcn add
chart` — creates `components/ui/chart.tsx`. Thin layer over recharts
(no library swap, no bundle bloat) but ships:

  - `<ChartContainer>` with responsive envelope + automatic CSS
    variable injection per data series (driven by a typed
    `ChartConfig`).
  - `<ChartTooltipContent>` — card-shaped tooltip with
    palette-aware border / shadow / typography that ties back to
    the config labels and colours via a dot indicator.
  - A wash of small fixes for recharts' default styling that don't
    line up with our warm-ambient palette out of the box (cursor
    colour, axis tick fill, grid stroke, dot fill).

All three chart components rewritten:

  - **`transactions-trend-chart.tsx`** — AreaChart inside
    ChartContainer. Gradient fill stops both pull from the chart-
    config CSS var so a future palette tweak is one place to edit.
    Active dot picks up the card background for the inner ring.
  - **`transactions-breakdown-bar-chart.tsx`** — BarChart with the
    same primitives. Rounded corners bumped to 6px to match the
    trend chart's curve weight.
  - **`status-donut-chart.tsx`** — PieChart with a per-slice
    `ChartConfig` built at render-time from the host's data.
    Self-explanatory chip-row legend renders below the donut
    showing label + count + percentage per slice, so the chart
    reads without hovering.

`pnpm exec shadcn add chart` added 1 file (`chart.tsx`) and reset
recharts to `^3.8.0` in package.json (functionally identical to
`^3.8.1` — both resolve to the same lockfile entry).

### Chunk 10 — Animation foundation + reports Figma uplift (commit `c9a8c4c`)

**Animation foundation in `app/globals.css`** — three CSS-only
utilities, server-render-safe (no JS, no flash):

  - `animate-fade-up` — single-element entry. Translates from 8px
    below + fades to opaque over 400ms with a soft cubic-bezier
    ease-out.
  - `stagger-children` — applies fade-up to every direct child with
    a 60ms cascade. Explicit delays for child 1-8.
  - `interactive-card` — hover-lift utility for non-link cards.
    200ms transition on transform + shadow; raises 2px on hover.

All three honour `prefers-reduced-motion` and collapse to static
no-ops.

Re-enabled recharts entrance animations on all three chart
components with 500-600ms durations + ease-out easing.

Wired into the dashboard: KPI strip + second admin strip-row +
status breakdown row + Quick Actions group all get
`stagger-children`. KpiStatCard, StatusBreakdownCard,
MonthTransactionsSummaryCard, TransactionsTrendCard, and the
reports TransactionsSummaryCard all pick up `interactive-card`.

**Reports Figma uplift**. The 06-reports.png screenshot is "To Be
Discussed" / empty — so the uplift mirrors the dashboard's
vocabulary verbatim:

  - New `<ReportsKpiStrip>` at the top of `/dashboard/reports` —
    admin sees 4 cards (Projects created / Tenders published /
    Transactions value / Transactions count); staff sees 2 (no
    financial cards). Wrapped in its own Suspense so the strip
    streams independently of the breakdown cards below.
  - `ProjectsSummaryCard` + `TendersSummaryCard` rewritten to use
    the shared `StatusBreakdownCard` (with `donut={true}`) — same
    donut + rows layout the dashboard uses. The bespoke per-card
    chrome is gone; everything snaps to one vocabulary. Static
    rows (no drill-through `href`) so a click can't leave the
    period context.
  - `StatusBreakdownCard` picks up an optional `href` field on
    `StatusBreakdownItem` — when omitted, the row renders as a
    plain `<div>` instead of a `<Link>` and drops the trailing
    chevron. Backwards-compatible with every existing caller.

## Key decisions

**Editable rejection reason renders only when the row is already
rejected.** The form doesn't surface `complianceStatus` itself —
that's the transition panel's job. Showing the reason field on a
pending or compliant company's edit form would invite confusion
("am I about to reject them?"). The conditional render keeps the
form scoped to "edit context for an already-decided state."

**Action-layer back-door guard, not just schema.** Day 23's
`updateCompanySchema.superRefine` catches "rejected ⇒ reason" only
when the patch includes `complianceStatus: "rejected"`. A patch
that clears `rejectionReason: null` without touching status would
sail past. Adding the cross-field check in `updateCompany` (after
loading the existing row) closes that hole — the seed-invariant
verifier no longer has to be the safety net.

**Dedicated `transitionComplianceStatus` action, not just a wrapper
over `updateCompany`.** Two reasons: (1) the panel's payload shape
(`id + toStatus + reason`) is narrower than `updateCompanySchema`
and the validator is sharper for it; (2) the audit emission is
always `compliance_status_changed` here — no need for the
conditional verb routing `updateCompany` has to do. Costs ~30 lines
of action code; pays back in clarity at the call site and the
audit trail.

**Per-target reason requirements on the panel match the audit
weight.** `rejected` is terminal — required reason, min 5 chars,
destructive variant. `suspended` is reversible but adds friction —
optional reason. `compliant` / `non_compliant` / `expired` are
routine, easily reverted — no reason field. Same gradient the
ConfirmDialog primitive already supports via its `reasonField` prop;
the panel just picks the right value per target.

**`recharts` chosen over Tremor / Nivo / ECharts.** The earlier
"chart library" decision balanced bundle weight vs visual quality.
Recharts (`^3.8.1`, ~50KB gz tree-shaken) is the smallest jump from
zero. The shadcn/ui chart wrapper (added in Chunk 9) brought the
visual polish closer to Tremor without the dep swap.

**shadcn/ui chart wrapper, not a different library.** When the user
asked for "more modern and sleek", the path with the least blast
radius was to adopt the shadcn chart primitives (which wrap
recharts). Zero new runtime deps, palette-cohesive theming, card-
shaped tooltips, all the visual lift without rewriting against a
different lib. Tremor would have been a closer second; ECharts /
Nivo would have meant ~half-day rewrites for visually similar
results.

**URL-driven trend filters, not React state.** Two reasons: (1) the
dashboard stays a Server Component (filter changes re-resolve the
server aggregate, not a client refetch), and (2) the filter state
survives a page refresh / shareable link. Cost: a small
`<TrendFilters>` Client Component + `router.replace({ scroll: false
})` plumbing. Same pattern the reports page already uses for its
period + company pickers.

**Pull the filter resolvers OUT of the "use client" file.** After
the live-dev bug surfaced, the resolvers (`resolveTrendMonths`,
`resolveTrendType`) moved to `trend-filters-config.ts` — a plain TS
module with no React or "use client". Any future co-located helper
that the page also needs to import has to live somewhere similar.

**CSS-only animations, no motion library.** Could have reached for
Framer Motion or @react-spring; both are ~30-60KB gz adds. The
three utilities (`stagger-children`, `interactive-card`,
`animate-fade-up`) cover 90% of what we need with zero runtime
cost. Server-render-safe (the animation starts on first paint,
not after JS hydrates) so there's no flash-of-static-content.

**`prefers-reduced-motion` honoured.** The animation block in
`globals.css` has a `@media (prefers-reduced-motion: reduce)` query
that collapses every animation / transition to a no-op. Accessibility
isn't a bolt-on.

**KPI strip layout: 4 cards top row, 2 on a second row for admin.**
The Figma reference shows 4 cards on the admin view; we have 5
relevant figures (Total Companies, Total Projects, Total Project
Value, Amount Paid, Transactions This Month / Total Tenders). Two
rows keeps each card at a comfortable 4-column width on lg+. Staff
get a single 4-card row (no financial cards, so Total Tenders +
Transactions fill the empty slots); company-role stays at 3 cards.

**Reports page mirrors the dashboard's vocabulary instead of
inventing its own.** The 06-reports.png Figma is "To Be Discussed"
— free hand. Reusing `StatusBreakdownCard` (with `donut={true}`)
for the Projects/Tenders summary cards is cheaper than building
two more bespoke layouts and gives both pages the same visual
density. The reports rows skip the drill-through `href` since a
click would leave the period context.

## Gotchas surfaced

**`"use client"` files can't export plain functions called by
Server Components.** Next.js enforces this at runtime, not at build
time for dynamically-rendered pages. The trend-filter resolvers
slipped past `pnpm build` because the dashboard is cookie-gated and
the prerender pass never executes the page. Worth carrying as a
rule: if a Server Component imports from a `"use client"` module,
the import must be either a React component or a typed prop —
function calls or constants need to live elsewhere.

**`pnpm build` is not a substitute for `pnpm dev` on dynamic
routes.** The build verifies that the page compiles + that
statically-renderable routes execute cleanly. Dynamic routes (any
page with cookies / session lookup) are skipped at prerender time
and only run on actual request. The verification loop should
include a real dev-server pass for any UI work that touches a
dynamic route.

**`actions.ts` is `"use server"` — non-async exports are a
build-time error.** Originally placed `stripAdminOnlyFields` inside
`actions.ts` (Day-23 Chunk 4 work). The TypeScript check passed but
`pnpm build` would have caught it. Moved the helper to its own
non-client module (`lib/companies/field-strip.ts`) before running
the build. Same lesson as above — actions.ts is reserved for async
Server Actions.

**recharts' Tooltip formatter signature is wider than it looks.**
Initial typing was `(value: number, _name, item) => ...` which
fails type-check because recharts passes `ValueType | undefined`.
Fix: loosen to `(value, _name, item) => { const paise = Number(value)
|| 0; ... }` and coerce inside. Applies to every chart's tooltip.

**`pnpm exec shadcn add chart` resets the recharts caret.** The
component install moved `recharts: ^3.8.1` to `^3.8.0`.
Functionally identical (both resolve to the same lockfile entry,
both satisfy each other's caret ranges), but a small annoyance —
worth noting in case a future shadcn install changes a more
load-bearing pin.

**The donut's per-render `ChartConfig` works but is unconventional.**
Most shadcn chart consumers define a `config: ChartConfig` at
module level. The donut needs one entry per slice and the slice set
is dynamic (host-provided), so building the config inside the
component on every render is the pragmatic choice. Performance is
fine at <10 slices; if a future caller has hundreds of slices,
swap to a memoised version.

**Date arithmetic for the monthly trend window uses UTC.** The
`buildMonthWindow` helper uses `Date.UTC` to compute the calendar
month series. Without this, the window would drift by one month for
deployments outside UTC near the start/end of a month. The fixtures
test this deterministically by always running against the test
runtime's actual clock.

## Surfaces touched

```
# Chunk 1 — Editable rejectionReason (commit 21de823)
app/dashboard/companies/[id]/edit/page.tsx                    (modified — pass viewerRole)
app/dashboard/companies/new/page.tsx                          (modified — pass viewerRole)
components/companies/company-form.tsx                         (modified — new section + form-state plumbing)
lib/companies/__tests__/actions.test.ts                       (modified — +3 back-door tests)
lib/companies/actions.ts                                      (modified — cross-field guard)

# Chunk 2 — Transition panel (commit 0bad769)
app/dashboard/companies/[id]/_components/compliance-transition-panel.tsx   (new — Client Component)
app/dashboard/companies/[id]/page.tsx                         (modified — render panel)
lib/companies/__tests__/actions.test.ts                       (modified — +13 transition tests)
lib/companies/__tests__/state-machine.test.ts                 (modified — +7 helper tests)
lib/companies/actions.ts                                      (modified — new action)
lib/companies/schemas.ts                                      (modified — new schema)
lib/companies/state-machine.ts                                (modified — legalNextStatuses + hasAny helpers)

# Chunk 3 — Initial charts (commit 16e6e11)
app/dashboard/_components/transactions-trend-card.tsx         (new — Server Component card)
app/dashboard/_components/transactions-trend-chart.tsx        (new — Client Component chart)
app/dashboard/page.tsx                                        (modified — wire trend card)
app/dashboard/reports/_components/transactions-breakdown-bar-chart.tsx     (new — Client Component)
app/dashboard/reports/_components/transactions-summary-card.tsx (modified — embed bar chart)
lib/dashboard/__tests__/aggregates-period.test.ts             (modified — +8 aggregate tests)
lib/dashboard/aggregates.ts                                   (modified — 2 new aggregates)
package.json                                                  (modified — recharts ^3.8.1)
pnpm-lock.yaml                                                (modified)

# Chunk 4 — Financial KPIs (commit 786a4f7)
app/dashboard/page.tsx                                        (modified — KPI strip refresh)
lib/dashboard/__tests__/aggregates.test.ts                    (modified — +10 KPI aggregate tests)
lib/dashboard/aggregates.ts                                   (modified — 3 new aggregates)
lib/format/inr.ts                                             (modified — formatInrCompact)

# Chunk 5 — Donut charts (commit 61c97bc)
app/dashboard/_components/status-donut-chart.tsx              (new — Client Component)
app/dashboard/_components/status-breakdown-card.tsx           (modified — donut prop)
app/dashboard/page.tsx                                        (modified — colour map + donut=true)

# Chunk 6 — Trend filters (commit 062dc1b)
app/dashboard/_components/transactions-trend-card.tsx         (modified — months + type props)
app/dashboard/_components/trend-filters.tsx                   (new — Client Component)
app/dashboard/page.tsx                                        (modified — resolve URL params)
lib/dashboard/__tests__/aggregates-period.test.ts             (modified — +3 type-filter tests)
lib/dashboard/aggregates.ts                                   (modified — transactionType filter)

# Chunk 7 — Quick Actions (commit 0a1400a)
app/dashboard/_components/quick-actions-bar.tsx               (new — Server Component)
app/dashboard/page.tsx                                        (modified — render row)

# Chunk 8 — "use client" boundary fix (commit 41711f9)
app/dashboard/_components/trend-filters-config.ts             (new — shared resolvers)
app/dashboard/_components/trend-filters.tsx                   (modified — drop resolver exports)
app/dashboard/page.tsx                                        (modified — swap import)

# Chunk 9 — shadcn chart primitives (commit 3af9bb0)
app/dashboard/_components/status-donut-chart.tsx              (modified — ChartContainer)
app/dashboard/_components/transactions-trend-chart.tsx        (modified — ChartContainer)
app/dashboard/reports/_components/transactions-breakdown-bar-chart.tsx     (modified — ChartContainer)
components/ui/chart.tsx                                       (new — shadcn primitive, via CLI)
package.json                                                  (modified — caret reset)
pnpm-lock.yaml                                                (modified — no-op)

# Chunk 10 — Animations + reports uplift (commit c9a8c4c)
app/dashboard/_components/kpi-stat-card.tsx                   (modified — interactive-card)
app/dashboard/_components/month-transactions-summary-card.tsx (modified — interactive-card)
app/dashboard/_components/quick-actions-bar.tsx               (modified — stagger-children)
app/dashboard/_components/status-breakdown-card.tsx           (modified — optional href + interactive-card)
app/dashboard/_components/status-donut-chart.tsx              (modified — animation re-enabled)
app/dashboard/_components/transactions-trend-card.tsx         (modified — interactive-card)
app/dashboard/_components/transactions-trend-chart.tsx        (modified — animation re-enabled)
app/dashboard/page.tsx                                        (modified — stagger-children on sections)
app/dashboard/reports/_components/projects-summary-card.tsx   (rewritten — use StatusBreakdownCard)
app/dashboard/reports/_components/reports-kpi-strip.tsx       (new — admin/staff KPI strip)
app/dashboard/reports/_components/tenders-summary-card.tsx    (rewritten — use StatusBreakdownCard)
app/dashboard/reports/_components/transactions-breakdown-bar-chart.tsx     (modified — animation re-enabled)
app/dashboard/reports/_components/transactions-summary-card.tsx (modified — interactive-card)
app/dashboard/reports/page.tsx                                (modified — KPI strip + stagger)
app/globals.css                                               (modified — animation utilities)

# Day 24 report (this commit)
docs/reports/day-24-report.md                                 (new)
```

## Test totals

Before this session: **592 tests across 33 files** (Day 23 end
state).

After this session: **636 tests across 33 files**, all green every
run. Net: **+44** across the existing test files.

Breakdown:

  - +3:  `lib/companies/__tests__/actions.test.ts` (Chunk 1 — back-
    door guard tests).
  - +20: `lib/companies/__tests__/actions.test.ts` (+13) +
    `state-machine.test.ts` (+7) — Chunk 2 transition action +
    helpers.
  - +8:  `lib/dashboard/__tests__/aggregates-period.test.ts` —
    Chunk 3 monthly trend + breakdown.
  - +10: `lib/dashboard/__tests__/aggregates.test.ts` — Chunk 4
    KPI aggregates.
  - +3:  `lib/dashboard/__tests__/aggregates-period.test.ts` —
    Chunk 6 type filter.
  - +0:  Chunks 5 / 7 / 8 / 9 / 10 — UI / wiring / library
    swap / CSS / page rewrites. The visual / animation surface
    doesn't have a render harness to test against; the contracts
    they depend on (aggregates, state machine) are already
    covered.

Total test count by chunk:

  - End of Day 23: 592
  - After Chunk 1: 595 (+3)
  - After Chunk 2: 615 (+20)
  - After Chunk 3: 623 (+8)
  - After Chunk 4: 633 (+10)
  - After Chunks 5-7: 636 (+3, from Chunk 6 alone)
  - After Chunks 8-10: 636 (+0, no test changes)

## Followups for Day 25+

**From this session:**

1. **Apply the same chart vocabulary to the other Figma screens.**
   Five Figma screenshots haven't been visited: companies-list,
   tenders-list, projects-list, transactions, settings. Most of
   them already have rows-of-counts cards or filter bars; the
   donut + KPI strip vocabulary could land natively. Settings is
   unlikely to need charts but a CSS pass would still help.

2. **Sparkline mini-charts inside the KPI cards.** The strip is
   four static numbers today; a 30-day mini area chart in the card
   background would make it a mini-dashboard. ~2 hr session,
   depends on a small new aggregate per KPI.

3. **Period-over-period comparison on the reports page.** Overlay
   "this period vs previous" on the existing charts. Would need a
   second aggregate call per chart + a thin overlay rendering pass.

4. **Loading skeletons for the dashboard cards.** Everything
   renders cold today — the dashboard waits on the longest
   aggregate before painting. Wrapping each section in Suspense +
   skeleton would let the page stream.

5. **Detail-page animation pass.** Company / project / tender
   detail pages haven't picked up the `interactive-card` /
   `stagger-children` utilities yet. ~30 min audit + a few file
   touches.

6. **Compliance state-transition history widget.** The
   `compliance_status_changed` audit verb now has a UI surface
   (the panel writes it), but there's no widget that surfaces just
   the compliance-state-change rows on a per-company history
   timeline. Day-23 followup #2 still open.

7. **Resend email on compliance state change.** Needs the Resend
   domain verified (deployment-session followup) before this
   becomes actionable. Day-23 followup #3.

8. **Bulk-transition action for admins.** Move a set of pending
   companies to non_compliant in one click. Now feasible with the
   state-machine in place. Day-23 followup #5.

**Carried forward (unchanged from Day 23):**

9. Realistic Indian-flavoured fixture data (Day-21 followup #2).
10. Real R2 fixture files (Day-21 followup #3).
11. Public registration UX / CAPTCHA / rate limiting (Day-15).
12. Real Consultway logo on the PDF cover.
13. Streaming exports beyond 1000 rows (Phase-3).
14. Searchable typeahead selects on forms + reports pickers.
15. Per-document CSV export / Bulk CSV import / Saved-report-
    config persistence / deleteProject / Project-attached documents
    / Side-by-side detail view / TransactionType badge palette
    unification / session invalidation on password reset / public
    tender browsing / OpenNext install / D1 client factory / Resend
    domain verification / Real Cloudflare bucket UUIDs / Hoist
    escapeHtml. All Day-15 or earlier carry-forwards.

**Already-resolved this session:**

  - Day-23 followup #1 (admin edit form for `rejectionReason`):
    Chunk 1.
  - Day-23 followup #4 (per-status transition button panel):
    Chunk 2.

## Carry-forward to Day 25

- **`origin/dev` ends at `c9a8c4c`** (the last work commit of this
  session — every Day-24 chunk was pushed as it landed, per the
  rolling-push pattern Mayuresh used through the day). The Day-24
  report commit is the only one local at the time of writing.
  Pushing the report still requires explicit approval per
  `<permissions>`.
- **Full session commit list** (all on `origin/dev` already):
  `21de823` / `0bad769` / `16e6e11` / `786a4f7` / `61c97bc` /
  `062dc1b` / `0a1400a` / `41711f9` / `3af9bb0` / `c9a8c4c`.
- **636 tests passing on every run.** No new test files added this
  session — all +44 land in pre-existing files.
- **Schema unchanged from Day 22 (migration 0013).** Day 24
  generated no migration — `rejection_reason` + the widened
  ComplianceStatus union were already in.
- **One new dependency**: `recharts ^3.8.0`. The only chart
  library on the project. Bundle impact ~50KB gz on
  admin/dashboard-render-only routes.
- **One new shadcn component**: `components/ui/chart.tsx`. Thin
  wrapper around recharts.
- **`pnpm db:seed`** continues to land every row as `unchanged`
  against the existing dev DB.
- **`pnpm seed:verify`** clean.
- **`pnpm cron:*`** all unchanged — Day 24 didn't touch crons.
- **`compliance_status_changed` audit verb is now emitted from two
  sites**: `updateCompany` (when a status patch moves the row) and
  `transitionComplianceStatus` (every time, by definition). Both
  write the same shape so any future audit-feed widget reading
  this verb sees a single contract.
- **The animation utilities (`stagger-children`, `interactive-
  card`, `animate-fade-up`) are available globally** via
  `app/globals.css`. New cards / sections that want the same
  vocabulary just opt in by class. `prefers-reduced-motion` is
  honoured.
- **The shadcn chart primitive (`components/ui/chart.tsx`) is the
  recommended way to add any new chart.** It provides
  `<ChartContainer>`, `<ChartTooltip>`, `<ChartTooltipContent>`,
  `<ChartLegend>` — and a typed `ChartConfig` shape that injects
  CSS variables per data series.
- **The `StatusBreakdownCard` primitive accepts `donut` +
  `href?`-optional items.** Reports cards already use this pattern;
  any future per-status summary on a detail page can opt in
  similarly.
- **Manual browser pass on the chart polish + animations deferred
  to Mayuresh.** Builds clean; the animation utilities are
  CSS-only and the chart components are isolated, but
  visual verification needs a real browser.

That's Day 24.
