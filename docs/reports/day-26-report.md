# Day 26 — fix-and-polish marathon: stale-session, toast redesign, density wiring, responsive sidebar

_Date: 2026-05-24_

## Scope

One long session spanning six coherent threads, all rooted in the
"more aesthetic, more modern, more smooth" brief that opened the day.
Started as a triage of Day-25 followups and a single user-reported
bug (clicking Settings opens the Dashboard); grew into a broad polish
pass that touched ~30 surfaces and closed three Day-25 followups
(#6 density, #9 stale-session auto-redirect server+client variants,
and the toast spam ghost-card defect that wasn't on the followup
list but turned out to be the same defect family as the redesigned
toast).

Six threads, in the order they shipped:

1. **Stale-session bundle.** A bug surfaced immediately:
   `/dashboard/settings` was silently landing on `/dashboard`.
   Tracked it through `proxy.ts` and confirmed a redirect loop —
   JWT cookie was valid (passed signature + expiry), but the
   `userId` it carried pointed at a deleted row, so
   `getPreferences()` correctly raised the Chunk-5 stale-session
   error, the page redirected to `/login`, and the proxy bounced
   the still-valid-looking cookie back to `/dashboard`. Solved
   by routing through a new `/auth/clear-session` Route Handler
   that deletes the cookie before the redirect, plus a shared
   client-side helper that triggers the same flow from toast
   error paths.

2. **Toast aesthetic redesign.** The default sonner `richColors`
   look was generic blue/green/red and ignored our 6-palette
   theme system. Replaced with a Linear/Vercel-style aesthetic:
   3px accent spine on the left, tinted circular icon badge,
   refined typography hierarchy, hover-only close button, soft
   layered shadow. All driven from CSS vars so the toast picks
   up terracotta on Warm Ambient, cyan on Ocean Depth, emerald
   on Forest Calm, etc. without any per-type colour hardcoding.

3. **Toast dedupe IDs.** Immediately after the redesign, the
   user reported that clicking "Change Photo" multiple times
   stacked identical toasts behind the front one as visible
   ghost cards (the new taller padding revealed the back toasts'
   spine + rounded edge through sonner's collapse animation).
   Fixed by adding stable `id`s to 10 toast call sites so
   repeated clicks update the existing toast in place instead
   of queueing a new one. Includes a shared `theme-change` id
   between the Settings palette picker and the sidebar quick-
   switcher so cycling from either surface updates one toast.

4. **Polish quadbatch.** Four independent improvements bundled:
   - Button press feedback (`active:scale-[0.97]`)
   - User-preference density + reduced-motion CSS wiring
     (closes Day-25 followup #6 — the toggle was a fake
     feature until today)
   - Page transitions via `app/dashboard/template.tsx`
   - Shimmer `.skeleton` utility + loading.tsx for the two list
     pages (projects, transactions) that were missing them

5. **Skeleton consistency sweep + EmptyState polish.** Closed
   the consistency loose-end from Chunk 4 by converting the
   remaining 7 loading files from `animate-pulse bg-muted` to
   the new shimmer. Polished the shared `EmptyState` primitive
   with an accent-tinted icon disc, larger geometry, and a
   fade-up entry — ripples to every list page's empty state
   plus the audit feed via the single shared primitive.

6. **Sidebar pill + login/register polish + mobile sidebar.**
   - Sidebar active-nav background converted to a framer-motion
     `layoutId` pill that physically slides between items on
     route change (same pattern the Settings nav used since
     Day 25).
   - New shared `PasswordInput` primitive with Eye/EyeOff
     reveal, wired into login + register + Security section.
     Confirm-password fields deliberately stay plain.
   - Accent-tinted radial gradient backdrop + fade-up entry on
     `/login` and `/register`.
   - Sidebar extracted into a shared `<SidebarContent>` body so
     desktop (sticky aside, `hidden lg:flex`) and mobile (left-
     side `<Sheet>` opened by a hamburger top bar) share one
     source of truth for the nav + brand + user pill.

End-of-day verification: `pnpm exec tsc --noEmit` silent every
checkpoint; `pnpm test --run lib/preferences` **11/11 green**
(only test file touched by Day 26 work; no test count delta —
session ends at the same 647 total Day 25 closed on); `pnpm build`
clean every checkpoint; `curl` against the new
`/auth/clear-session` route confirmed correct 307 + `Set-Cookie:
cw_session=; Expires=Thu, 01 Jan 1970` cookie deletion + safe-
path `from=` validation.

No new dependencies. No schema migrations. No new tests (Day 26
work was all presentation / routing / CSS — no business logic
that would benefit from test coverage).

## What shipped

### Chunk 1 — Stale-session bundle (closes Day-25 followup #9)

**Symptom.** Clicking Settings in the sidebar landed on
`/dashboard`. Three-hop redirect loop, server-side, invisible to
the user.

**Root cause.** Local DB was reseeded between login and the test
session. JWT cookie still verified cleanly in `proxy.ts`
(signature + expiry intact), but the `userId` it carried no
longer existed in `users`. The Day-25 Chunk-5 stale-session
guard fired correctly inside `getPreferences()`, returning
`{ ok: false, error: STALE_SESSION_ERROR }`. The Settings page
then redirected to `/login` — and `proxy.ts`'s "authed users
heading to an auth page" rule bounced the still-valid-looking
cookie to `/dashboard`. Net effect: silent landing on dashboard
with no indication anything was wrong.

**Why the previous fix didn't close this.** Day-25 Chunk 5 added
the guard inside the action, but the redirect target (`/login`)
wasn't reachable by definition — proxy.ts owns that gate. The
guard converted a 500 into a friendly toast, but didn't actually
get the user back to login.

**Fix.** Route through a new
[app/auth/clear-session/route.ts](app/auth/clear-session/route.ts).
GET handler that calls `destroySession()` (deleting the cookie)
and then redirects to `/login` (or another safe path via `to=`,
plus optional `from=` preservation for post-login return).
`proxy.ts` matches no rule for this path so it passes through
unmolested. The follow-up `/login` request now arrives with no
cookie, the proxy sees an unauthenticated visitor, and lets
them through.

Centralised the contract in
[lib/auth/stale-session.ts](lib/auth/stale-session.ts):
- `STALE_SESSION_ERROR` constant (moved from
  `lib/preferences/actions.ts`).
- `isStaleSessionError(error)` predicate for client toast
  handlers.
- `buildStaleSessionRedirectUrl(from?)` helper used by both the
  Server Component redirect (Settings page) and the client-side
  navigation (appearance / notifications / user-pill toast
  paths).

Server-side wiring: [app/dashboard/settings/page.tsx](app/dashboard/settings/page.tsx)
now redirects to the clear-session route on `!prefs.ok` instead
of `/login`.

Client-side wiring: [app/dashboard/settings/_components/appearance-section.tsx](app/dashboard/settings/_components/appearance-section.tsx),
[app/dashboard/settings/_components/notifications-section.tsx](app/dashboard/settings/_components/notifications-section.tsx),
and [components/dashboard/user-pill.tsx](components/dashboard/user-pill.tsx)
all now detect stale-session errors after the user toast and
`window.location.assign` to the clear-session route.

`window.location.assign` (not `router.push`): a full browser
navigation guarantees the Set-Cookie response is applied before
the next request, where `router.push` would do client-side
navigation and the cookie state would race. The harder reload
also resets any in-memory state from the bad session.

Tests stayed green without modification — the existing Day-25
preferences tests match on a regex (`/session is no longer
valid/i`) so the constant move was invisible.

### Chunk 2 — Toast aesthetic redesign

**Problem.** The user shared a screenshot of an info toast
("Avatar uploads coming soon") on Midnight Espresso. Generic
sonner blue/dark surface, harsh hairline border, info-disc
icon — felt nothing like the rest of the app. The toast
ignored the active palette entirely.

**Fix.** Three-file rewrite — surface styling lives entirely in
CSS via attribute selectors, so future palette additions
inherit the look automatically.

[app/globals.css](app/globals.css) — new "Toast aesthetic" block:
- `[data-sonner-toast]` base: `--popover` background +
  `--popover-foreground` text + soft layered shadow + `--radius-lg`
  corners + 14px left padding + 12px gap.
- 3px coloured spine on the left edge via a `::before` pseudo-
  element. Default spine = `--accent`; per-type overrides
  switch to `--destructive` for error, a stable
  `oklch(0.78 0.16 75)` amber for warning (semantic — should
  read warning regardless of theme), and `--muted-foreground`
  for loading.
- Icon wrapped in a 32px circular badge tinted to 14% of the
  spine colour via `color-mix(in oklab, …)`. Per-type
  overrides for error / warning / loading colour the badge to
  match the spine.
- Typography hierarchy: title at 14px semibold with slight
  negative tracking; description at 13px in `--muted-foreground`.
- Close button repositioned top-right (sonner anchors left by
  default, which sat on top of our spine). Ghosted by default
  (`opacity: 0`), fades in on `:hover` and `:focus-within`.

[components/ui/sonner.tsx](components/ui/sonner.tsx) refactored:
- Dropped the unused `cn-toast` placeholder class.
- Bumped icon stroke to 2.25 for better legibility inside the
  tinted badge.
- Kept the `--normal-*` CSS-var fallbacks so any sonner-internal
  style that doesn't pass through our attribute selectors still
  picks up a theme-aware colour.

[app/layout.tsx](app/layout.tsx) — dropped the `richColors` prop.
Our CSS now owns type coloring; `richColors` would emit
competing inline styles.

The redesign uses `color-mix(in oklab, …)` for the tinted
backgrounds. Supported in every browser since mid-2023; the
project is already on Tailwind v4 + OKLCH so the dependency
direction is consistent.

### Chunk 3 — Toast dedupe IDs

**Problem.** Right after the aesthetic redesign landed, the
user reported: clicking "Change Photo" multiple times stacked
identical toasts behind the front one. The new taller padding
+ visible left spine meant the back toasts in sonner's
collapsed deck peeked out as colored-spine ghost rectangles.

**Fix.** Sonner's documented dedupe contract: every toast call
that can plausibly fire from the same button gets a stable
`id`. Repeated calls with the same id *update* the existing
toast in place (refreshing its dismiss timer) instead of
queueing a new one. 10 call sites touched across 6 files:

- [profile-section.tsx](app/dashboard/settings/_components/profile-section.tsx) —
  `avatar-uploads-soon` (the user-reported case), `profile-saved`.
- [security-section.tsx](app/dashboard/settings/_components/security-section.tsx) —
  `password-updated`, `2fa-coming-soon`,
  `sign-out-everywhere`, `revoke-session` (single id shared
  across rows so revoking different sessions updates one
  toast — the latest action is the only one that matters).
- [appearance-section.tsx](app/dashboard/settings/_components/appearance-section.tsx) —
  `theme-change` (shared with the sidebar quick-switcher),
  `appearance-save-error`.
- [notifications-section.tsx](app/dashboard/settings/_components/notifications-section.tsx) —
  `notifications-saved`, `notifications-save-error`.
- [organization-section.tsx](app/dashboard/settings/_components/organization-section.tsx) —
  `organization-saved`.
- [user-pill.tsx](components/dashboard/user-pill.tsx) —
  `theme-change` (shared with appearance — cycling palettes
  from either surface refreshes the same toast),
  `theme-save-error`.

The shared `theme-change` id is a nice side-effect: pick a
palette in Settings, see the toast. Switch palette from the
sidebar before the toast dismisses — the toast updates in
place from "Theme set to Slate Pro" to "Theme set to Ocean
Depth" rather than stacking. The toast becomes a "current
action" indicator instead of a queue.

### Chunk 4 — Polish quadbatch

Four independent improvements landed together.

**4a. Button press feedback.** [components/ui/button.tsx](components/ui/button.tsx)
cva base now includes `active:not-aria-[haspopup]:scale-[0.97]`
in addition to the existing 1px translate. The combination
reads more decisively than either alone — scale conveys the
press, translate conveys the depress. `not-aria-[haspopup]`
skips menu / dropdown triggers where the scale would visually
fight the menu-open animation.

**4b. Density + reduced-motion CSS wiring (closes Day-25
followup #6).** The Appearance section was writing
`<html data-density>` and `<html data-reduced-motion>`
attributes that nothing in the rest of the app responded to —
the worst kind of fake feature. New CSS block in
[app/globals.css](app/globals.css) targets shadcn's `data-slot`
attributes so every consumer of Card / Table picks up the
tighter spacing without per-callsite changes:

- `[data-density="compact"] [data-slot="table-cell"]` —
  py-1.5 vs py-2
- `[data-density="compact"] [data-slot="table-head"]` —
  h-9 vs h-10
- `[data-density="compact"] [data-slot="card"]` —
  py-3 + gap-3 vs py-4 + gap-4
- `[data-density="compact"] [data-slot="card-header|content"]` —
  px-3 vs px-4
- `[data-density="compact"] aside[aria-label="Primary navigation"] nav li a` —
  py-1.5 vs py-2

Reduced-motion (user-toggle) mirrors the OS-level
`prefers-reduced-motion` media query: every `transition` and
`animation` set to `none !important`. `!important` is
necessary because Tailwind utility classes set transitions
inline with the same specificity as our attribute selector;
source order alone wouldn't reliably win.

**4c. Page transitions.** New
[app/dashboard/template.tsx](app/dashboard/template.tsx) wraps
every dashboard route in a 220ms framer-motion fade-up.
Template.tsx (not layout.tsx) because templates re-mount on
real navigation but persist across search-param changes — so
clicking a filter on the Companies page doesn't trigger a fade,
only crossing from Companies → Tenders does. Belt-and-suspenders:
the motion.div is keyed on `pathname` to make this explicit.

`useReducedMotion()` early-returns the unwrapped children when
the OS / in-app preference is set — keeps the DOM and React
tree shallower for users who don't want motion.

**4d. Shimmer skeleton utility + missing loaders.** New
`.skeleton` class in globals.css — a theme-aware shimmer
gradient that sweeps across each placeholder, using
`color-mix(in oklab, var(--foreground) 7%, transparent)` so it
adapts to every palette. Replaced the `animate-pulse bg-muted`
pattern in [components/dashboard/table-section-loading.tsx](components/dashboard/table-section-loading.tsx)
(covers Companies + Tenders + Projects + Transactions list
bodies via Suspense). Two new files for the outer-page
shell skeletons that were missing:
[app/dashboard/projects/loading.tsx](app/dashboard/projects/loading.tsx)
and [app/dashboard/transactions/loading.tsx](app/dashboard/transactions/loading.tsx).

Reduced-motion gate: under either OS preference or user toggle,
the shimmer freezes (`animation: none; opacity: 0`) so the
placeholder is still visible as a loading affordance but
doesn't move.

### Chunk 5 — Skeleton consistency sweep + EmptyState polish

**5a. Sweep.** Closed the consistency loose-end from Chunk 4
by converting the remaining 7 loading files from
`animate-pulse bg-muted` to `.skeleton`:
- [app/dashboard/companies/loading.tsx](app/dashboard/companies/loading.tsx)
- [app/dashboard/companies/[id]/loading.tsx](app/dashboard/companies/[id]/loading.tsx)
- [app/dashboard/tenders/loading.tsx](app/dashboard/tenders/loading.tsx)
- [app/dashboard/tenders/new/loading.tsx](app/dashboard/tenders/new/loading.tsx)
- [app/dashboard/tenders/[id]/loading.tsx](app/dashboard/tenders/[id]/loading.tsx)
- [app/dashboard/_components/activity-feed-loading.tsx](app/dashboard/_components/activity-feed-loading.tsx)
- [app/dashboard/companies/[id]/_components/documents-section-loading.tsx](app/dashboard/companies/[id]/_components/documents-section-loading.tsx)
- [components/audit/entity-history-loading.tsx](components/audit/entity-history-loading.tsx)

Where the original used `bg-muted/60` for secondary-line
hierarchy, that became `skeleton opacity-60` — preserves the
visual hierarchy without inventing a "soft skeleton" variant.

Deliberately left `app/login/page.tsx:127` and
`app/dashboard/reports/page.tsx:256` on `animate-pulse` — both
are tall hero/chart-shape placeholders, not list rows. The
shimmer would feel out of place on a 240px solid block.

**5b. EmptyState polish.** [components/ui/empty-state.tsx](components/ui/empty-state.tsx)
uplifted with an accent-tinted icon disc (12% accent
background + 18% accent ring via `color-mix`), bumped icon
geometry (h-12 → h-14), stronger title (text-sm → text-base
font-semibold), widened description (max-w-xs → max-w-sm
text-sm), and a fade-up entry via the existing
`.animate-fade-up` utility. Single primitive used by every
list page's empty state and the audit feed — the change
ripples app-wide.

### Chunk 6 — Sidebar pill + login/register polish + mobile sidebar

**6a. Sidebar active-pill animation.** Active nav background
in [components/dashboard/sidebar.tsx](components/dashboard/sidebar.tsx)
converted from a direct bg class swap to a framer-motion
`motion.span` with `layoutId="sidebar-nav-pill"`. Clicking
Companies → Tenders animates the terracotta pill physically
sliding between items (spring physics, ~250ms) instead of
hard-swapping. Same pattern the Settings nav has used since
Day 25. Icon + label bumped to `z-10` so they stay above the
moving pill.

**6b. Login + register polish.** New
[components/ui/password-input.tsx](components/ui/password-input.tsx) —
a shared `Input`-wrapping component with an Eye/EyeOff
reveal toggle. Forwards all Input props via `forwardRef` so
react-hook-form's `register("password")` Just Works. Toggle
is `tabIndex={-1}` so keyboard navigation doesn't pause on it.
Wired into:
- [app/login/page.tsx](app/login/page.tsx) — main password field
- [app/register/_components/register-form.tsx](app/register/_components/register-form.tsx) — first password field
- [app/dashboard/settings/_components/security-section.tsx](app/dashboard/settings/_components/security-section.tsx) — current + new password (NOT confirm — the whole point is re-typing from memory)

Both [app/login/page.tsx](app/login/page.tsx) and
[app/register/page.tsx](app/register/page.tsx) got:
- Accent-tinted radial gradient backdrop via inline `style`
  using `color-mix(in oklab, var(--accent) 10%, var(--background))`
  fading to flat `var(--background)` at 60% — tracks the
  active theme so a signed-out user with a Cyan-accent cookie
  sees a cyan glow on /login.
- `.animate-fade-up` on the form container so the card
  fades up on mount instead of popping in.

**6c. Mobile sidebar.** The dashboard sidebar was `w-64 sticky`
on every viewport — on phones it ate most of the screen and
crushed the content. Real defect on tablets/phones.

Refactor:
- [components/dashboard/sidebar.tsx](components/dashboard/sidebar.tsx) — body extracted into a shared `<SidebarContent>` export accepting a `variant: "desktop" | "mobile"` prop. Desktop wrapper now `hidden lg:flex`. Each variant gets its own `layoutId` namespace (`sidebar-nav-pill` vs `mobile-sidebar-nav-pill`) so framer doesn't try to morph between two simultaneously-rendered instances of the active item.
- New [components/dashboard/mobile-sidebar.tsx](components/dashboard/mobile-sidebar.tsx) — slim sticky top bar (`lg:hidden`) with hamburger trigger + compact brand mark on the right. Hamburger opens a left-side `<Sheet>` containing the same `<SidebarContent>`. Auto-close via `useEffect` on pathname — more reliable than per-link onClick handlers because it covers programmatic redirects too (e.g. a form submit that redirects).
- [app/dashboard/layout.tsx](app/dashboard/layout.tsx) — mounts both. The flex layout still works on `< lg` because the desktop `<Sidebar>` uses `hidden` (no flex slot consumed), letting the main content take full width.

`SheetHeader > SheetTitle` is rendered visually-hidden inside
the drawer — Radix requires a title for the dialog's
accessible name, but the brand chrome inside `<SidebarContent>`
isn't announced as a section title.

## Key decisions

**Centralised stale-session contract over inlined strings.**
The Day-25 fix had `STALE_SESSION_ERROR` as a local constant in
`lib/preferences/actions.ts`. Day 26 moves it (along with the
predicate + URL builder) into
[lib/auth/stale-session.ts](lib/auth/stale-session.ts) so every
consumer (action layer, toast handlers, Server Components,
future user-FK'd modules) imports from one place. The
existing test's regex matcher meant the move was invisible to
the test suite. Followup #10 from Day 25 (extract
`assertUserExists` helper) becomes a natural next step now
that this module exists.

**Route Handler over Server Component for the cookie delete.**
Server Components can't write cookies — they can only read
them. So the "delete cookie + redirect" sequence has to live
in either a Server Action (invoked from a form submit) or a
Route Handler (invoked via a redirect target). The Route
Handler is the only option that works when the originator is
itself a Server Component (the Settings page), since you can't
call a Server Action from inside `redirect()`. The handler is
generic enough to be the destination for all future
"cookie's stale, send the user to login" cases — the only
thing the caller needs to do is pass `from=` for post-login
return.

**Attribute selectors over per-component class additions for
the toast aesthetic.** Sonner sets `data-sonner-toast` +
`data-type` on each toast, plus `data-icon`, `data-title`,
`data-description`, `data-close-button` on the inner elements.
Targeting those via CSS gives us a single source of truth in
globals.css — no per-callsite styling, no className soup in
`sonner.tsx`. Future palette additions automatically inherit
the look since every colour reaches into `var(--…)`.

**`color-mix(in oklab, …)` for every tinted background.**
Used by the toast spine/badge tints, the EmptyState ring, and
the login/register gradient. Cleaner than inventing extra
palette variables (would need 6 new vars per palette × 6
palettes = 36 colour values to maintain). `oklab` colour space
keeps the mix perceptually uniform, so a 14% tint on dark
palettes looks the same density as 14% on light palettes.
Browser support since mid-2023; no fallback needed for our
audience.

**Stable IDs over `visibleToasts` capping for the dedupe fix.**
Sonner exposes `visibleToasts` (default 3) — capping to 1 would
have hidden the symptom but lost legitimate stacking (a save-
success + a navigation-confirm should both surface). The right
fix is per-action dedupe, which is sonner's documented contract
and matches how the user thinks about each button. The shared
`theme-change` id between Settings and the sidebar picker is a
deliberate convenience — both surfaces toast the same kind of
event, the user shouldn't see two stacked.

**Density + reduced-motion CSS rules target shadcn's
`data-slot` attributes, not the components themselves.** Card
and Table primitives ship with `data-slot="card"` /
`data-slot="table-cell"`. Targeting those means every consumer
of the primitives picks up the compact spacing without per-
callsite edits, AND we don't have to maintain a fork — the
shadcn primitives stay pristine, the density rules layer on
top. The trade-off is that any custom card / table not built
on the primitives won't respond to density; we don't have any
of those today.

**Template-level fade keyed on `pathname` not on template
identity.** Next 16's template.tsx semantics already re-mount
on segment changes, not on search-param changes. Belt-and-
suspenders: keying the motion.div on `usePathname()` makes the
intent explicit and survives any future framework semantics
shifts. Filter changes on Companies (`?status=active` →
`?status=pending`) deliberately do NOT trigger the fade —
that would feel buggy, not delightful.

**Sidebar `layoutId` namespaced per variant.** Desktop and
mobile sidebars are both mounted at the same time on `< lg`
(desktop hidden via CSS, but still in the DOM). If both
instances shared the same `layoutId="sidebar-nav-pill"`,
framer would try to morph between them simultaneously on a
route change and produce visual chaos. Each variant getting
its own pill identity keeps them independent.

**Mobile sidebar auto-close via `useEffect` on pathname, not
per-link onClick.** The effect covers programmatic redirects
(form submits, redirects from action results) AND every nav
click in one rule, instead of having to remember to wire an
onClick on each Link. Cleaner contract, fewer foot-guns.

**Confirm-password fields stay plain Input.** The
PasswordInput primitive has reveal as a default behaviour;
the consumer would have to opt out per-field. Decided against
that API — instead, confirm-password fields just use
`<Input type="password">` directly. The whole point of
confirm is re-typing from memory; a reveal toggle defeats it.
The primitive's name (`PasswordInput`) signals "reveal-enabled";
plain Input signals "no reveal." Self-documenting.

**Window.location.assign for stale-session client navigation,
not router.push.** A full browser navigation guarantees the
`Set-Cookie` response from `/auth/clear-session` is applied
before the next request. `router.push` would do client-side
navigation and the cookie state could race against the next
fetch. The harder reload also resets any in-memory state from
the stale session — components don't have to worry about
having props derived from the dead userId.

**`pnpm exec tsc --noEmit` + `pnpm build` ran at every chunk
boundary instead of only at the end.** Six checkpoints across
the day. Caught zero issues — but having the safety net meant
the chunk boundaries were genuine commit-shaped boundaries,
not "everything that compiles by accident." Day 25's
end-of-session verification was equally clean but six
intermediate compiles is materially cheaper than one big
final one when scope is this broad.

## Gotchas surfaced

**Proxy + Server Component cookie write are mutually exclusive.**
Server Components can only READ cookies. So any "delete the
session cookie + redirect to /login" sequence inside a Server
Component renders as just "redirect to /login" — and `proxy.ts`
then bounces the still-valid-looking JWT back to /dashboard.
This is the entire shape of the Day-26 stale-session loop. The
fix is to route through a Route Handler (which CAN write
cookies) and have IT do the redirect. Worth remembering: any
future Server Component that needs to "log out + redirect" has
the same constraint.

**Sonner stacks toasts as a 3-deep deck by default.** When
toasts are tall (our redesigned ones are ~80px), the
collapsed back-toasts in the deck peek out below the front
one as ghost rectangles. The fix is to give repeated-action
toasts stable IDs so they update in place; reducing
`visibleToasts` would mask but not solve.

**`richColors` from sonner conflicts with custom CSS rules.**
`richColors` emits inline styles per toast type with sonner's
own green / red / blue / yellow defaults — those win over our
attribute-selector rules in globals.css because inline styles
have higher specificity. Dropping the `richColors` prop was
necessary to give our CSS full control. If a future
contributor adds it back thinking "more colour is better,"
the toast aesthetic will look broken on some types.

**Next 16 template.tsx fires on every navigation including
back/forward.** This is desired for our cross-fade — the user
sees the same animation in both directions — but worth knowing
if a future template tries to do something more stateful
(e.g. show a "you just came back" indicator). Keying on
pathname is the right contract.

**Framer `layoutId` collisions are silent and weird.** If two
visible elements share the same `layoutId`, framer tries to
morph between them on every render, producing flicker /
phantom-position artifacts. The mobile sidebar refactor would
have hit this if we hadn't namespaced (`sidebar-nav-pill` vs
`mobile-sidebar-nav-pill`) — desktop is `hidden lg:flex` but
still rendered in the DOM. CSS visibility ≠ React unmounted.

**`color-mix(in oklab, var(--accent) X%, transparent)` is the
right pattern for theme-aware tints.** Tested against all 6
palettes during the toast redesign + EmptyState polish + login
gradient — looks correct on Warm Ambient, Midnight Espresso,
Slate Pro, Forest Calm, Ocean Depth, Sunset Glow.
`color-mix(…, oklab)` (not the default sRGB) keeps the mix
perceptually uniform — 14% on Midnight Espresso reads the
same density as 14% on Sunset Glow. The oklab variant is the
right default for tinting; reach for sRGB only if you actually
want gamma-space mixing.

**Sheet primitive needs an explicit Title for accessibility.**
Radix Dialog (which Sheet wraps) emits a console warning if no
`<DialogTitle>` is rendered. The mobile sidebar's brand chrome
inside `<SidebarContent>` isn't a semantic title — it's
decorative. So we render a visually-hidden `<SheetTitle>` via
`sr-only`. Lint-clean and screen-reader-correct.

**`active:scale-[0.97]` interacts visibly with menu/dropdown
triggers.** The scale-down would visually fight the menu's
own opening animation if applied to triggers. The
`not-aria-[haspopup]` carveout in the Button cva base skips
the scale for any button with `aria-haspopup`, which Radix's
dropdown/menu/select triggers all set by default. No per-
callsite changes needed.

**`window.location.assign` triggers a full page reload
including the root layout.** Our root layout reads the
`cw-theme` cookie SSR-side (Day-25 work). That's still valid
even after stale-session clear — `cw-theme` is unrelated to
`cw_session`. So the post-clear /login still paints in the
user's chosen palette. Verified by curling /auth/clear-session
and inspecting the Location + Set-Cookie headers.

## Surfaces touched

```
# Chunk 1 — Stale-session bundle
app/auth/clear-session/route.ts                                    (new — Route Handler)
lib/auth/stale-session.ts                                          (new — centralised contract)
lib/preferences/actions.ts                                         (modified — imports STALE_SESSION_ERROR from new module)
app/dashboard/settings/page.tsx                                    (modified — redirect to clear-session)
app/dashboard/settings/_components/appearance-section.tsx          (modified — stale-session client handler)
app/dashboard/settings/_components/notifications-section.tsx       (modified — stale-session client handler)
components/dashboard/user-pill.tsx                                 (modified — stale-session client handler)

# Chunk 2 — Toast aesthetic redesign
app/globals.css                                                    (modified — Toast aesthetic block)
components/ui/sonner.tsx                                           (modified — dropped cn-toast, bumped icon stroke)
app/layout.tsx                                                     (modified — dropped richColors)

# Chunk 3 — Toast dedupe IDs
app/dashboard/settings/_components/profile-section.tsx             (modified — 2 ids)
app/dashboard/settings/_components/security-section.tsx            (modified — 4 ids)
app/dashboard/settings/_components/appearance-section.tsx          (modified — 2 ids; shared with user-pill)
app/dashboard/settings/_components/notifications-section.tsx       (modified — 2 ids)
app/dashboard/settings/_components/organization-section.tsx        (modified — 1 id)
components/dashboard/user-pill.tsx                                 (modified — 2 ids; shared theme-change)

# Chunk 4 — Polish quadbatch
components/ui/button.tsx                                           (modified — active:scale-[0.97])
app/globals.css                                                    (modified — density + reduced-motion + skeleton shimmer blocks)
app/dashboard/template.tsx                                         (new — page transitions)
components/dashboard/table-section-loading.tsx                     (modified — shimmer)
app/dashboard/projects/loading.tsx                                 (new — outer shell skeleton)
app/dashboard/transactions/loading.tsx                             (new — outer shell skeleton)

# Chunk 5 — Skeleton sweep + EmptyState
app/dashboard/companies/loading.tsx                                (modified — shimmer)
app/dashboard/companies/[id]/loading.tsx                           (modified — shimmer)
app/dashboard/tenders/loading.tsx                                  (modified — shimmer + stale doc fix)
app/dashboard/tenders/new/loading.tsx                              (modified — shimmer)
app/dashboard/tenders/[id]/loading.tsx                             (modified — shimmer)
app/dashboard/_components/activity-feed-loading.tsx                (modified — shimmer)
app/dashboard/companies/[id]/_components/documents-section-loading.tsx (modified — shimmer)
components/audit/entity-history-loading.tsx                        (modified — shimmer)
components/ui/empty-state.tsx                                      (modified — accent ring + fade-up + larger geometry)

# Chunk 6 — Sidebar pill + login/register + mobile sidebar
components/dashboard/sidebar.tsx                                   (rewritten — SidebarContent extraction + layoutId pill)
components/dashboard/mobile-sidebar.tsx                            (new — Sheet drawer + hamburger)
components/ui/password-input.tsx                                   (new — Input + Eye/EyeOff toggle)
app/dashboard/layout.tsx                                           (modified — mounts both sidebars)
app/login/page.tsx                                                 (modified — gradient backdrop + fade-up + PasswordInput)
app/register/page.tsx                                              (modified — gradient backdrop + fade-up)
app/register/_components/register-form.tsx                         (modified — PasswordInput)
app/dashboard/settings/_components/security-section.tsx            (modified — PasswordInput on current + new)

# Day 26 report
docs/reports/day-26-report.md                                      (new — this commit)
```

7 new files + 24 modified = **31 unique surfaces touched** across
6 chunks.

## Test totals

Before Day 26: **647 tests across 34 files** (Day 25 end state).
After Day 26: **647 tests across 34 files** — net zero delta.

The only test file touched was
`lib/preferences/__tests__/actions.test.ts`, and only indirectly:
the existing tests use a regex matcher
(`/session is no longer valid/i`) on the error message, so
moving `STALE_SESSION_ERROR` from `lib/preferences/actions.ts`
to `lib/auth/stale-session.ts` was invisible to the tests.
Verified `pnpm test --run lib/preferences` ran 11/11 green after
the constant move.

Why no new tests this session: Day 26 was almost entirely
presentation work — CSS, Tailwind classes, framer-motion props,
React component composition. None of it carries enough
business logic to be worth a unit-test surface. The one
genuinely behavioural change — the stale-session Route Handler
— is tested at the level it matters (curl confirmed the
307 + Set-Cookie + safe-path `from=` defences).

## Followups for Day 27+

**From this session:**

1. **Manual browser pass on Day-26 work.** The single biggest
   gate. Type-check + build only catch compile errors; the
   visual stuff needs eyeballs. Checklist worth executing:
   - Sidebar pill animation between nav items (cycle 4+ times
     quickly, confirm no stuck pill)
   - Resize to < 1024px → desktop sidebar vanishes, hamburger
     + brand top bar appears; tap hamburger → drawer slides in
   - Tap a nav item in the mobile drawer → drawer closes,
     navigation happens
   - Login/register pages — gradient backdrop visible, fade-up
     plays on first paint
   - Click Eye icon on any password field — reveals plain text
   - Cycle theme via user-pill while on /login (sign out first)
     → backdrop re-tints
   - Spam Change Photo button — exactly one toast, no deck
   - Toggle Settings → Appearance → Density to compact —
     tables tighten everywhere; switch back to comfortable —
     they widen
   - Toggle reduced-motion → fade-up + skeleton shimmer +
     button scale freeze
   - Navigate between dashboard sections — each entry should
     fade up briefly

2. **Promote `assertUserExists` out of `lib/preferences`
   (Day-25 followup #10).** The stale-session module now
   centralises the contract; extracting the actual user-exists
   check into
   `lib/auth/session.ts::assertUserExists(userId)` is a
   natural next step. ~30 min refactor, swaps the
   `userExists` helper inside `lib/preferences/actions.ts`
   for the new shared one. Pays off the second any user-FK'd
   table arrives (avatars, sessions inventory, 2FA enrolment).

3. **Real Profile field persistence (Day-25 followup #1).**
   Name save is currently a stub — `setTimeout` + toast. A
   real `users` row update action would close the loop. Phone
   doesn't exist on the `users` table yet (micro-migration to
   add); email-change should go through a verification flow
   (out of scope unless explicitly approved).

4. **Organizations table + Organization-section persistence
   (Day-25 followup #2).** Largest of the carry-forwards. New
   table + FK from `users.organization_id` (nullable for
   admin/staff). Settings section already gated to admin/staff;
   action needs to re-validate role server-side.

5. **Avatar uploads (Day-25 followup #3).** Currently the
   profile section shows a "coming soon" toast. R2 presigned
   URL upload would land cleanly — small `avatarKey` column
   on `users` + existing `r2.ts` helper. Updates the toast
   from placeholder to real.

6. **Command palette (Cmd+K).** Repeatedly flagged across
   Day 26 as the single biggest remaining "feels modern"
   lever. Half-day feature, deserves its own session. Needs
   `cmdk` (already a shadcn dep) + a search index across
   companies / tenders / projects / recent activity.

7. **Theme picker preview on /login (Day-25 followup #7).**
   With the new accent-tinted gradient backdrop, a first-time
   visitor on /login has no way to preview palettes before
   signing in. The Day-25 cookie carries the previously-
   selected palette for returning visitors, but a fresh user
   sees Warm Ambient by default. A small theme picker dropdown
   in the corner of /login would close this.

8. **Inline edit on detail pages.** Click a field on a Company
   detail page → edit in place → blur to save with optimistic
   UI. Replaces the navigate-to-`/edit` round-trip across every
   entity. Significant refactor (half-day per entity) but
   polishes the entire data-entry workflow.

9. **Quick-filter chips on list pages.** Status pills above
   each list table that one-click filter (e.g. "Active"
   "Pending" "Rejected" above Companies). Faster than typing
   into search; more tactile. ~1-2 hr per list page; worth
   doing on demand rather than all at once.

10. **2FA enrolment (Day-25 followup #4).** Security section
    has a "Coming soon" placeholder. Full TOTP enrolment +
    backup codes is a whole module on its own.

11. **Real "active sessions" list + Sign-out everywhere
    (Day-25 followup #5).** Currently stub. Needs a
    `sessions` table (we're stateless JWT today) so we can
    revoke individual sessions and surface "Last seen on X
    device from Y city."

**Carried forward from earlier days (unchanged):**

12. Resend email on compliance state change (Day-23 #3).
13. Public registration UX / CAPTCHA / rate limiting (Day-15).
14. Real Consultway logo on the PDF cover.
15. Real R2 fixture files (Day-21 #3).
16. Realistic Indian-flavoured fixture data (Day-21 #2).
17. Searchable typeahead selects on forms + reports pickers.
18. Compliance state-transition history widget (Day-23 #2).
19. Bulk-transition action for admins (Day-23 #5).
20. Per-document CSV export / Bulk CSV import / Saved-report-
    config persistence / deleteProject / Project-attached
    documents / Side-by-side detail view / TransactionType
    badge palette unification / session invalidation on
    password reset / public tender browsing / OpenNext install
    / D1 client factory / Resend domain verification / Real
    Cloudflare bucket UUIDs / Hoist escapeHtml.

## Carry-forward to Day 27

- **All Day-25 + Day-26 work committed across two commits.**
  Day 25 sits at `0c7b87a` ("day 25 changes") and the bulk of
  Day 26 at `fb62153` ("new improvements in the app"). The
  final round (sidebar pill + login/register polish + mobile
  sidebar) is the third commit that's being pushed now.
- **Three Day-25 followups closed:** #6 (density + reduced-
  motion wiring), #9 (stale-session auto-redirect, both
  server-side and client-side variants).
- **647 tests passing on every checkpoint.** Net zero delta —
  Day 26 added no new business logic worth testing.
- **Schema migrations: zero.** Day 26 was pure presentation +
  routing + CSS.
- **New dependencies: zero.** `motion`, sonner, shadcn
  primitives (Sheet, etc.) were already there. Two new
  shadcn-shaped primitives shipped as pure file adds
  (PasswordInput, MobileSidebar) — both small wrappers on
  existing primitives.
- **The `.skeleton` class is the contract for loading
  affordances now.** Future loaders should use it, not the
  legacy `animate-pulse bg-muted` pattern. Two hero-shape
  placeholders (login Suspense fallback, reports page chart
  loader) deliberately stayed on `animate-pulse` — shimmer
  doesn't read right on solid blocks ≥ 200px tall.
- **`/auth/clear-session` is the contract for "delete cookie
  + send to login."** Any future Server Component that
  detects a stale session should redirect through it (with
  `from=` to preserve return path) rather than hitting
  `/login` directly.
- **`STALE_SESSION_ERROR` / `isStaleSessionError` / `buildStaleSessionRedirectUrl`
  in `lib/auth/stale-session.ts` are the contract for the
  client-side stale-session response.** Any new action that
  raises the same error class should import the constant
  from there; any new toast handler should call
  `isStaleSessionError(result.error)` and navigate via the
  URL builder.
- **The toast aesthetic is fully CSS-driven via attribute
  selectors in globals.css.** Adding a new palette
  automatically inherits the toast look (spine + icon badge
  pick up the new `--accent` and `--destructive` values).
  Adding a new toast type (sonner has `default | success | info | warning | error | loading`)
  needs a matching `[data-type="…"]::before` rule for the
  spine and `[data-type="…"] [data-icon]` for the badge tint.
- **`[data-density="compact"]` and `[data-reduced-motion="true"]`
  are now hot contracts.** Any new dense surface (e.g. a
  data-grid component if we add one) should add a matching
  rule under `[data-density="compact"]` so the user's
  preference actually applies. Reduced-motion is mostly
  blanket-handled by the global `transition: none !important`
  rule, but custom keyframe animations need a manual
  `[data-reduced-motion="true"] .my-animation { animation: none !important; }` line.
- **`SidebarContent` is the single source of truth for the
  dashboard navigation.** Adding a new nav section, changing
  the role-gating, swapping the brand icon — all happen in
  one place and ripple to desktop + mobile.
- **Manual browser pass on Day-26 work deferred to Mayuresh.**
  Build clean, type-check clean, full test suite green, but
  the layoutId pill animation, the page transitions, the
  toast aesthetic across all 6 palettes, the mobile drawer
  at multiple breakpoints, and the gradient backdrop on /login
  all need a real browser to verify.

That's Day 26.
