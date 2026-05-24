# Day 25 — Settings module + multi-palette theme system + sidebar quick-switcher

_Date: 2026-05-24_

## Scope

One long session, three coherent threads plus one in-session hotfix
— building the Settings module from zero, designing a 6-palette theme
system around it (with real dark variants for the first time on the
project), then closing the persistence loop with a `user_preferences`
table + Server Actions + a quick-switcher in the sidebar. A FK-
constraint regression surfaced when Mayuresh exercised the live UI
against a reseeded local DB; closed in the same session as Chunk 5.

1. **Settings page from zero.** The sidebar pointed at
   `/dashboard/settings` since Day 1 but the route 404'd. This session
   built the page out: a five-section shell (Profile, Appearance,
   Security, Notifications, Organization), framer-motion section
   transitions, a sticky save bar, and per-section forms wired through
   shared primitives (cards, switches, radio groups). Admin /
   staff-only Organization tab; everything else is universal.

2. **6-palette theme system, real dark mode included.** `app/globals.css`
   refactored from a single `:root` block into base + six theme-scoped
   variable sets — Warm Ambient (default), Midnight Espresso (dark),
   Slate Pro (light cool), Forest Calm (light green), Ocean Depth
   (dark navy), Sunset Glow (light peach). `next-themes` was already
   installed but unwired; a `<ThemeProvider>` wrapper went into
   `app/layout.tsx` with the catalog driven from `lib/themes.ts`.

3. **Persistence + no-flash SSR + sidebar quick-switcher.** Three
   follow-ups inside the same session: a `cw-theme` cookie so SSR
   paints the right palette on the very first frame; a
   `user_preferences` table (migration `0014`) with `getPreferences`
   + `updatePreferences` Server Actions; and a rewrite of the
   sidebar user-pill into a `DropdownMenu` with the 6-palette
   quick-switcher inline.

4. **Stale-session FK hotfix.** Live-UI testing surfaced a 500 on
   the first theme change — the session JWT was valid but pointed
   at a `userId` that no longer existed (the local DB had been
   reseeded between login and the test). `getPreferences` +
   `updatePreferences` both grew a user-existence guard that
   converts the case to a friendly `{ ok: false, error }` instead
   of letting the insert fault on the FK.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` **647/647** green (was 636; +11 across one new
test file `lib/preferences/__tests__/actions.test.ts`); `pnpm build`
clean; `pnpm db:migrate` applied `0014` against the local DB
cleanly; `pnpm exec eslint` clean across every touched file.

One framework gotcha showed up in the build output but didn't surface
as an error — the cookie read in the root layout makes every route
dynamic. Acceptable for this app (no SEO, no public landing). See
"Gotchas surfaced" below.

## What shipped

### Chunk 1 — Settings page + 6-palette theme system

**New dependency**: `motion` (framer-motion's new package name),
~30 KB gz. Deliberate departure from Day 24's "CSS-only animations
only" stance — the user explicitly asked for a motion library on
this surface to make the section-switcher, palette picker, and
save-bar feel modern. CSS utilities (`stagger-children`,
`interactive-card`, `animate-fade-up`) stay the default everywhere
else; framer is scoped to this page + the sidebar quick-switcher.

**New shadcn primitives** (via `pnpm dlx shadcn@latest add`):
`tabs`, `avatar`, `separator`, `radio-group`. Pure file adds — no
new runtime deps, since `radix-ui` umbrella is already there.

**Theme catalog** in `lib/themes.ts` — the single source of truth
for the 6 palettes the app ships. Each entry pairs the next-themes
class id with display metadata + 5 hex swatches the picker uses
for thumbnails. Ordered intentionally (Warm Ambient first so the
default is always the first card).

**Palette refactor** in `app/globals.css`. The original `:root`
block (Warm Ambient anchors only) split into:

  - `:root` — radius + non-color tokens shared across themes
  - `:root, .theme-warm-ambient` — the existing palette (unchanged
    values; just scoped to a class so theme switching works)
  - `.dark` — Midnight Espresso, the warm-ambient palette inverted
    into a dark mode (deep espresso surfaces, parchment text,
    brightened terracotta accent). Uses `.dark` so shadcn's
    pre-baked `dark:` utility variants — peppered through
    `components/ui/*` — activate at the same time.
  - `.theme-slate-pro` — Vercel/Linear-style cool slate + blue
  - `.theme-forest-calm` — sage cream + emerald
  - `.theme-ocean-depth` — deep navy + cyan
  - `.theme-sunset-glow` — soft peach + coral

Each block carries the full 22-variable set so any unset variable
can never fall through to a different palette mid-render. A 240ms
ease on background-color/border-color/color smooths the visual
jolt when the user switches themes; honours `prefers-reduced-motion`
exactly like Day 24's animation utilities.

**ThemeProvider wiring**. `components/theme-provider.tsx` wraps
`next-themes` with our catalog (`attribute="data-theme"`,
`themes={[...THEME_IDS]}`, `enableSystem={false}` — we don't try to
auto-map system dark/light to a specific palette, the user picks
explicitly). Mounted in `app/layout.tsx` around the existing
`<Toaster>`.

**Settings page surface** under `app/dashboard/settings/`:

  - `page.tsx` — Server Component, reads session + preferences,
    renders the shell. Bounces unauthenticated callers to `/login`
    twice (middleware + defensive re-check).
  - `_components/settings-shell.tsx` — Client Component, holds the
    active-section state. Two-pane layout: left nav (sticky on lg+)
    + right content area. Section switch uses framer-motion
    `AnimatePresence` with `mode="wait"` so the outgoing section
    finishes fading before the incoming one starts — keeps the
    visual focus narrow.
  - `_components/settings-nav.tsx` — left rail. Active item uses
    framer-motion `layoutId="settingsNavPill"` so the highlight
    pill physically slides between items rather than crossfading.
    Role-gated: the Organization item only renders for
    admin/staff per `docs/08-rbac-matrix.md`.
  - `_components/section-card.tsx` — local Card wrapper used by
    every section. Title + description in the header, optional
    headerAside slot (used by Appearance to show the active-theme
    pill), content slot. Picks up the `interactive-card` utility
    from Day 24 so hover feedback stays consistent with the rest
    of the dashboard.
  - `_components/profile-section.tsx` — name / email / phone /
    role display fields. Real `users` row hydrates the read-only
    role field; the editable fields are still local state with a
    stub save handler. Avatar uses the new shadcn `Avatar` with
    initials fallback.
  - `_components/appearance-section.tsx` — three cards: theme
    picker grid (6 palettes), density radio group
    (comfortable/compact), reduced-motion switch. All three apply
    live (no save step) — see Chunk 3 for the DB persistence wiring.
  - `_components/palette-preview-card.tsx` — single picker tile.
    Built around the 5-swatch hex array from `lib/themes.ts`.
    Renders a faux mini-window (header bar + sidebar + content
    surface + accent CTA) so the user can see the palette in
    context before committing. Framer-motion `whileHover`
    +`whileTap` micro-feedback; active state gets a 2px accent
    ring and an animated check badge.
  - `_components/security-section.tsx` — change-password form
    (current + new + confirm with strength hint), two-factor
    placeholder card with a "Coming soon" disabled enrol button,
    "Sign out everywhere" action with a `ConfirmDialog`. The
    password form submits to a stub action today; the dialog +
    sign-out flow is real (calls the existing `logout` action).
  - `_components/notifications-section.tsx` — two grouped cards
    (Email Digests + Real-time Alerts) of switches. Sticky save
    bar at the bottom; see Chunk 3 for the DB wiring.
  - `_components/organization-section.tsx` — admin/staff-only.
    Org name / industry / address / contact email / contact phone.
    Local state today (no `organizations` table yet); save handler
    stubbed and toasts on submit.
  - `_components/sticky-save-bar.tsx` — bottom-anchored bar that
    slides up via framer-motion when `isDirty=true`, slides down
    when clean or saving. Two buttons: Cancel (rolls back state)
    + Save (calls the section's save handler). Disabled while
    `isSaving`.

**Sidebar still points at the right URL.** The Settings link in
`components/dashboard/sidebar.tsx` was already in the NAV_ITEMS
array from Day 1; this is the first session where clicking it
doesn't 404.

### Chunk 2 — No-flash SSR via `cw-theme` cookie

**Problem.** `next-themes` reads localStorage at hydration time, so
the server-rendered HTML always paints the default palette and
flips once JS runs. For 50–200ms (on slow connections) the user
sees the wrong palette flash through. The login page is the worst
offender — it has no other content to mask the flash.

**Fix.** Dual-write: localStorage stays the source of truth for
the client (managed by next-themes itself), but a parallel cookie
(`cw-theme`) carries the same value so Server Components can read
it on every render and emit `<html data-theme="…">` with the right
palette from frame 1.

  - `lib/themes-cookie.ts` — cookie name, max-age (1 year),
    `resolveThemeFromCookie(raw)` validator (falls back to
    `DEFAULT_THEME` on unknown/stale ids), `buildThemeCookieString`
    helper so writers don't drift on cookie flags.
  - `components/theme-cookie-sync.tsx` — tiny side-effect-only
    Client Component. Subscribes to `useTheme().theme`; on every
    change, writes the cookie via `document.cookie =`. Renders
    `null`. Mounted once near the top of the tree
    (inside `<ThemeProvider>`).
  - `components/theme-provider.tsx` — picks up an `initialTheme`
    prop and forwards it as `defaultTheme` so the very first
    next-themes render matches the SSR HTML.
  - `app/layout.tsx` — now `async`. Reads the cookie via
    `cookies()`, resolves through the validator, sets
    `<html data-theme={initialTheme}>` AND passes `initialTheme`
    to `<ThemeProvider>`. Mounts `<ThemeCookieSync>` inside the
    provider.

After this change the palette is in DOM on the very first painted
byte — no flash, even on a hard refresh, even on `/login`.

### Chunk 3 — `user_preferences` table + Server Actions

**Schema** (migration `0014_yellow_thaddeus_ross.sql`).
`user_preferences` table, keyed by `user_id` (also the PK + FK to
`users.id`, cascade-deleted with the user). One row per user, by
construction. Columns:

  - `theme_id TEXT NOT NULL DEFAULT 'warm-ambient'` — validated
    app-side against `THEME_IDS` (no SQLite enum so the catalog
    can grow without a CHECK constraint change)
  - `density TEXT NOT NULL DEFAULT 'comfortable'` —
    `'comfortable' | 'compact'`
  - `reduced_motion INTEGER NOT NULL DEFAULT false` (boolean)
  - Six notification booleans:
    `weekly_digest` (default on), `monthly_report` (default off),
    `document_expiry`, `tender_alerts`, `assignment_alerts`,
    `incident_alerts` (all default on)
  - `created_at` / `updated_at` ISO-8601 (SQLite default +
    Drizzle `$onUpdate` hook)

No secondary indexes — `user_id` is the PK, every read hits it.

**Module** at `lib/preferences/`:

  - `schemas.ts` — `updatePreferencesSchema` (Zod, strict, every
    field optional → patch semantics). Theme id validated against
    the live `THEME_IDS` so a stored id from a removed palette is
    rejected on next save.
  - `actions.ts` —
    - `getPreferences()` — auth-gated; returns the persisted row
      if one exists, otherwise returns a hard-coded defaults
      shape (mirrors the column `.default(...)` calls). Lazy
      creation contract: the table starts empty for every user,
      first `updatePreferences` call inserts the row.
    - `updatePreferences(patch)` — auth-gated; validates patch;
      short-circuits on empty patch (returns existing row or
      defaults, no DB write); inserts a row from defaults + patch
      on first call; UPDATEs in place on subsequent calls.
      Returns the merged shape so callers don't need a re-fetch.
  - `__tests__/actions.test.ts` — 9 new tests:
    - unauthenticated `getPreferences` → `{ ok: false }`
    - `getPreferences` returns defaults when no row exists
    - `getPreferences` returns the persisted row when one exists
    - unauthenticated `updatePreferences` → `{ ok: false }`
    - first save inserts a row + returns merged shape + row is
      persisted
    - subsequent saves UPDATE in place (only one row in the table)
    - unknown theme id → `{ ok: false, field: "themeId" }`
    - empty patch short-circuits (no insert, returns defaults)
    - `updatedAt` advances on a real update

**No audit logging.** Deliberate. These are personal display
preferences with no security or business consequence — auditing
every theme switch would drown the real signal in noise. If we
ever need to debug "the user says their theme keeps resetting",
the structured-log line in `updatePreferences` is enough.

**Page wiring**:

  - `app/dashboard/settings/page.tsx` server-fetches prefs and
    passes them to the shell.
  - `_components/settings-shell.tsx` accepts `initialPreferences`,
    forwards to the two sections that own DB-backed prefs
    (Appearance + Notifications).
  - `_components/appearance-section.tsx` — theme/density/motion
    each call `updatePreferences` in a `useTransition`. Live UX
    is optimistic (the visual change happens before the round-trip);
    failures roll back the local state + toast an error.
  - `_components/notifications-section.tsx` — sticky save bar
    builds a minimal diff patch (only the keys the user
    actually changed) and sends it. On success the local
    "initial" snapshot is refreshed from the returned row so the
    save bar slides away.

### Chunk 4 — Sidebar quick-switcher

**New shadcn primitive**: `dropdown-menu` (via CLI). No new runtime
deps — `radix-ui` umbrella already there.

**`components/dashboard/user-pill.tsx`** rewritten. Was a static
"avatar + email + role + sign-out icon" row; now a `DropdownMenu`:

  - **Trigger** is the same identity row — avatar circle + email
    + role pill. Hover and `data-state=open` lift it via
    `bg-sidebar-accent` so it reads as interactive.
  - **Menu content** (anchored above, aligned to start):
    - "Settings" link to `/dashboard/settings`
    - "Theme" label + 6 menu items, one per palette. Each item
      carries a mini swatch trio (3 of the 5 hexes — bg + accent
      + secondary) so the dropdown has a visual fingerprint per
      palette without ballooning the row. Active palette gets a
      terracotta check icon on the right.
    - "Sign out" item — kept as a `<form action={logout}>` so the
      progressive-enhancement contract from the previous design
      survives (works without JS).

Theme writes are the same dual-flow as the Settings page:
`setTheme(id)` triggers the visual swap + cookie sync via
`<ThemeCookieSync>`, and `updatePreferences({ themeId })` persists
to the DB. Failures roll back the visual state and toast.

### Chunk 5 — Stale-session FK hotfix

**Symptom.** First palette change after Chunks 1–4 landed produced
a 500 in the dev server log:

```
SqliteError: FOREIGN KEY constraint failed
  code: 'SQLITE_CONSTRAINT_FOREIGNKEY'
  POST /dashboard/settings 500
  └─ ƒ updatePreferences({"themeId":"warm-ambient"})
```

`app/error.tsx` caught the unhandled throw and rendered the generic
"Something went wrong / try again" screen with the digest reference.

**Diagnosis.** The session JWT cookie was still valid (signature
good, not expired) but carried a `userId` that no longer existed in
the local `users` table. Most likely cause: the local DB had been
reseeded since the cookie was minted (`pnpm db:reset` / `pnpm db:seed`
between login and the live UI test), so the cookie pointed at a
ghost row. `updatePreferences` then tried to
`INSERT INTO user_preferences(user_id, …)` with the ghost id and the
FK to `users.id` refused.

**Fix.** New `userExists(userId)` helper in
`lib/preferences/actions.ts`, called at the top of BOTH
`getPreferences` and `updatePreferences`. On a missing row the
actions now return
`{ ok: false, error: "Your session is no longer valid. Please sign
out and sign in again." }` instead of letting the insert throw.
One indexed lookup per pref call — cheap.

A shared `STALE_SESSION_ERROR` constant pins the user-facing string
so the UI (which already renders `result.error` in the failure
toast) sees the same wording from both actions, and a future test
or telemetry consumer can match on it without a copy-paste drift.

Belt-and-suspenders applied to `getPreferences` too — even though
that action only `SELECT`s (no FK violation possible), bouncing on a
ghost session there means the Settings page's server-side load
fails cleanly and the layout redirects to `/login`, instead of
rendering a half-broken settings shell that will only fault when the
user tries to save.

**Tests (+2, 645 → 647).** Both new tests mock `readSession` to
return a session with `userId: newId()` (random UUID with no
matching row) and assert `{ ok: false, error: /session is no longer
valid/i }`. The `updatePreferences` test additionally confirms no
ghost row got written — a regression where a future maintainer
removes the guard but leaves the action otherwise intact would
silently start inserting orphaned rows; this test would fail
immediately.

**Workaround called out for Mayuresh.** Sign out via the sidebar
user-pill, then sign back in — the fresh JWT carries the current
`users.id` and every action works again.

## Key decisions

**Dark mode landed in palette form, not as a separate axis.**
`app/globals.css` previously carried a comment noting dark mode
was deferred until it could be "designed deliberately." When the
user asked for theme support this session, we built dark variants
as palettes (Midnight Espresso, Ocean Depth) rather than as a
separate light/dark toggle on top of the existing palette. Two
reasons: (1) treating "dark or light" as a property of the
palette keeps the catalog the single source of truth — six
palettes, each owning its own surface-foreground contrast story;
(2) it avoids the "what does light-mode-of-ocean-depth even look
like?" combinatorial problem. Midnight Espresso uses the `.dark`
class so shadcn's pre-baked `dark:` utility variants still fire;
Ocean Depth lives on `.theme-ocean-depth` alone (no `.dark`
class), so any `dark:` utilities scattered through shadcn
components do *not* fire under Ocean Depth. That's accepted —
the palette's own variable values handle every contrast pair
explicitly.

**framer-motion only on Settings + the sidebar dropdown, not
everywhere.** Day 24's "CSS-only animations only" decision still
holds for the rest of the app. The motion library was added
because the user explicitly asked for it on this surface, and
because Settings has motion patterns (section crossfade, palette
tile bounce on tap, save-bar slide-in, animated check badge,
nav-pill that physically slides between items via `layoutId`)
that aren't expressible cleanly in CSS without a runtime helper.
Bundle cost ~30 KB gz, isolated to routes that import from
`motion/react` — so the dashboard / companies / tenders bundles
don't pay for it.

**Theme stored as a class on `<html>` (`attribute="data-theme"`),
not on a wrapper div.** Two reasons: shadcn's `dark:` variants
read up the ancestor chain and `<html>` is the only ancestor
guaranteed to exist for portals (`<Toaster>`, `<DropdownMenu>`
content, etc. mount to `<body>` via Radix's portal); and putting
it on `<html>` lets `app/layout.tsx` set the class in the SSR
HTML directly via `<html data-theme={initialTheme}>` with no
hydration round-trip.

**`cw-theme` is a parallel cookie, not a localStorage
replacement.** Could have ripped out `next-themes`' localStorage
write and replaced it with the cookie. Chose to dual-write
instead: localStorage stays the read source on the client (zero
network access, instant), cookie is the read source on the
server. Cost is one extra `document.cookie =` per theme change,
which is negligible. Benefit is that we keep `next-themes`'
battle-tested inline script for "no flash on first paint after
storage read" as a defence-in-depth backup even if the cookie
write somehow fails.

**`user_preferences` keyed by `user_id` (not a surrogate `id`
column).** One row per user by definition, so a separate UUID PK
adds noise and lets a single user accidentally have multiple
rows (e.g. from a buggy bulk-insert). Making `user_id` the PK
makes "upsert this user's prefs" a single index-only operation
and removes the foot-gun.

**Lazy row creation, not seed-time row creation.** Could have
added a `user_preferences` insert to every user signup flow + a
backfill for existing users. Chose to leave the table empty and
let `getPreferences` synthesise defaults when no row exists. Two
benefits: (1) the table size grows in proportion to users who
actually visit Settings (more honest signal); (2) we don't have
to migrate existing seed data, and the `pnpm db:seed` invariant
verifier doesn't have to know about prefs.

**`getPreferences` returns the defaults shape on miss, not
`null`.** Callers (Settings page, sidebar dropdown) always want
"the prefs to render with" — branching on "is the row there yet"
in every consumer would be tedious and bug-prone. Returning
`{ ok: true, preferences: defaults }` on miss collapses both
cases to one branch.

**Patch-style updates, not full-row replace.** Every column on
`updatePreferencesSchema` is `.optional()`. Two reasons: (1) the
sidebar quick-switcher only cares about `themeId` and doesn't
want to know or care what the user's notification toggles are
set to; (2) builds a clean diff-patch contract where the action
sees "only the columns this user actually changed", which makes
the structured log + future audit trail (if we ever add one)
self-documenting.

**Optimistic UI on the Appearance section, save-bar pattern on
Notifications.** The two sections have different ergonomics. A
theme picker is a "this one, please" instant action — the user
clicks and expects the page to re-skin immediately; a 300ms
round-trip with a "Save" button would feel broken. Notification
preferences are batched ("turn off X and Y, leave Z") — the
save-bar pattern (toggle a few switches, then commit) maps to
how the user actually thinks about them. Same `updatePreferences`
action behind both; the difference is purely in the calling
shape.

**Profile + Organization sections still mock-save.** The DB work
this session was scoped to `user_preferences` only. Profile would
need a `users` row update action (with email-change verification
flow), Organization would need a new `organizations` table. Both
are their own PRs. The save-bar wiring is already shaped to swap
in the real action with no UI change — when those PRs land, only
the section's `onSave` handler needs to swap from a `setTimeout`
stub to the real call.

**Sidebar dropdown puts theme picker inline, not behind a sub-
menu.** Six palettes is short enough to inline as flat menu items.
A sub-menu would add a hover-intent delay + an extra click for no
real value. Each row carries a 3-swatch fingerprint so the user
can pick by sight rather than by name.

**Logout stays a `<form action={logout}>` inside the dropdown
item.** The previous user-pill design did `<form action={logout}>`
+ button so JS-disabled environments could still log out. Wrapping
the form inside `<DropdownMenuItem asChild>` keeps that contract;
Radix renders into our form's button via `asChild`. Loses the
hover-on-trigger UX feel slightly (the whole dropdown closes when
the form submits), but the progressive-enhancement story matters
more than the polish here.

## Gotchas surfaced

**Every route is now dynamic.** The root layout's `cookies()`
read flips Next.js into per-request rendering for every page in
the app. `/login`, `/forgot-password`, etc. were `○ Static`
before; they're now `ƒ Dynamic`. For an internal portal with
cookie-gated UX this is fine (no SEO, no edge-cache pressure),
and it's *necessary* so the theme cookie applies on the very
first painted byte of the login page too — otherwise an
Ocean-Depth user would see warm-ambient flash on `/login` after
sign-out. If we ever add a public/static landing page (or a
public tender-browsing route) we'd extract the cookie read into a
`(dashboard)` route-group layout instead of `app/layout.tsx`.

**`pnpm exec shadcn add dropdown-menu` brought no new runtime
deps.** The `radix-ui` umbrella was already in `package.json` from
earlier shadcn installs. Same was true for `tabs`, `avatar`,
`separator`, `radio-group` — every shadcn primitive we pulled in
this session is a pure file add. The only new dep this session
was `motion ^12.40.0`.

**`useTheme().theme` is `undefined` on first render before
hydration.** `<ThemeCookieSync>` would otherwise write a `cw-theme=
undefined` cookie on first mount if we didn't early-return on
`!theme`. The early-return is the entirety of the protection;
without it, the cookie would have to be re-validated on read
(which the validator already does, so no actual breakage — but
clean inputs beat sturdy parsers).

**Density / reduced-motion CSS hooks set on `<html>.dataset`, not
via React state on a wrapper div.** Same reason as the theme
class — Radix portals (Toaster, DropdownMenu content) mount to
`<body>`, so a wrapper-div approach would leave portaled content
on whatever the page-level state is. `<html>.dataset.density =
"compact"` is global by definition.

**`DropdownMenuItem` + `<form action={...}>` works but is
unconventional.** Radix's `DropdownMenuItem` with `asChild` lets
us render the menu item as our form's button, preserving the
form-action contract. If Radix ever tightens its rendering
contract (forcing menu items to render specific element types),
the fallback would be `onSelect={() => formAction()}` losing the
JS-disabled fallback.

**`densitySchema = z.enum(...)`** is the source of truth for the
DB column's typed union. If a third density mode lands, both
`lib/preferences/schemas.ts` and the `$type<"comfortable" |
"compact">()` annotation in `lib/db/schema.ts` need updating
together. Drizzle doesn't enforce union-narrowing on its own.

**SQLite `datetime('now')` resolves to seconds, but Drizzle's
`$onUpdate` hook stamps milliseconds.** The `updatedAt` bump test
uses a "greater than or equal" comparison with a 5ms sleep so a
same-second second write still passes. Won't false-fail on fast
hardware.

**framer-motion is published as `motion`, not `framer-motion`.**
The package was renamed in Motion 11+. Imports are
`import { motion } from "motion/react"`, not the old
`from "framer-motion"`. Codemod-friendly if we ever flip back,
but worth knowing — Stack Overflow and the docs are still mixed.

**A valid session JWT does NOT imply a live user row.** The session
cookie is signed + has a 7-day TTL; it survives any DB operation
that drops/recreates `users` rows (`pnpm db:reset`, dropped-and-
restored snapshot, manual `DELETE FROM users WHERE …`). Every
action that inserts a row keyed on `session.userId` therefore needs
a user-existence guard or it will FK-fault on a stale cookie.
Chunk 5 added the guard to the preferences module; the same
pattern should be applied if any new module ever introduces a
user-keyed table (avatars, sessions inventory, 2FA enrolment, etc.).
The alternative — re-checking user existence inside `readSession()`
on every request — was rejected because the cost is per-request DB
hits everywhere, and most reads don't care about the FK case.

**`app/error.tsx` masks the SQLite error message in the browser.**
The 500 surfaces as the generic "Something went wrong / try again
/ reference: <digest>" screen — useful for users, opaque for
debugging. The real error (`SqliteError: FOREIGN KEY constraint
failed`) only shows up in the dev-server stdout / Workers log
stream. If you're chasing a 500 that the error boundary swallowed,
always cross-reference the digest against the server log. The
"reference" in the UI matches `digest` in the log line.

## Surfaces touched

```
# Chunk 1 — Settings page + theme system + new primitives
app/dashboard/settings/page.tsx                                  (new)
app/dashboard/settings/_components/settings-shell.tsx            (new — Client Component)
app/dashboard/settings/_components/settings-nav.tsx              (new — framer layoutId pill)
app/dashboard/settings/_components/section-card.tsx              (new — local Card wrapper)
app/dashboard/settings/_components/profile-section.tsx           (new)
app/dashboard/settings/_components/appearance-section.tsx        (new)
app/dashboard/settings/_components/palette-preview-card.tsx      (new — framer hover/tap)
app/dashboard/settings/_components/security-section.tsx          (new)
app/dashboard/settings/_components/notifications-section.tsx     (new)
app/dashboard/settings/_components/organization-section.tsx      (new)
app/dashboard/settings/_components/sticky-save-bar.tsx           (new — framer slide-up)
app/globals.css                                                  (modified — 6 palettes)
app/layout.tsx                                                   (modified — async, cookie, ThemeProvider)
lib/themes.ts                                                    (new — catalog + helpers)
components/theme-provider.tsx                                    (new — next-themes wrapper)
components/ui/tabs.tsx                                           (new — shadcn CLI)
components/ui/avatar.tsx                                         (new — shadcn CLI)
components/ui/separator.tsx                                      (new — shadcn CLI)
components/ui/radio-group.tsx                                    (new — shadcn CLI)
package.json                                                     (modified — + motion)
pnpm-lock.yaml                                                   (modified)

# Chunk 2 — No-flash SSR via cookie
lib/themes-cookie.ts                                             (new — cookie helpers)
components/theme-cookie-sync.tsx                                 (new — Client Component side-effect)
components/theme-provider.tsx                                    (modified — initialTheme prop)
app/layout.tsx                                                   (modified — read cookie, wire prop)

# Chunk 3 — user_preferences table + Server Actions
lib/db/schema.ts                                                 (modified — userPreferences table)
drizzle/0014_yellow_thaddeus_ross.sql                            (new — migration)
drizzle/meta/0014_snapshot.json                                  (new — drizzle meta)
drizzle/meta/_journal.json                                       (modified — drizzle journal)
lib/preferences/schemas.ts                                       (new)
lib/preferences/actions.ts                                       (new)
lib/preferences/__tests__/actions.test.ts                        (new — 11 tests; 9 in Chunk 3 + 2 in Chunk 5)
app/dashboard/settings/page.tsx                                  (modified — fetch prefs)
app/dashboard/settings/_components/settings-shell.tsx            (modified — accept prefs)
app/dashboard/settings/_components/appearance-section.tsx        (modified — real persistence)
app/dashboard/settings/_components/notifications-section.tsx     (modified — real persistence)

# Chunk 4 — Sidebar theme switcher
components/ui/dropdown-menu.tsx                                  (new — shadcn CLI)
components/dashboard/user-pill.tsx                               (rewritten — DropdownMenu)

# Chunk 5 — Stale-session FK hotfix
lib/preferences/actions.ts                                       (modified — userExists guard on both actions)
lib/preferences/__tests__/actions.test.ts                        (modified — +2 stale-session tests)

# Day 25 report (this commit)
docs/reports/day-25-report.md                                    (new)
```

## Test totals

Before this session: **636 tests across 33 files** (Day 24 end
state).

After this session: **647 tests across 34 files**, all green every
run. Net: **+11** in one new file (`lib/preferences/__tests__/
actions.test.ts`).

Breakdown:

  - +9 (Chunk 3): `lib/preferences/__tests__/actions.test.ts` —
    auth gating × 2 (read + write), defaults shape on miss,
    persisted-row read, first-save insert, subsequent UPDATE in
    place, unknown-theme rejection with `field: "themeId"`,
    empty-patch short-circuit, `updatedAt` advances.
  - +2 (Chunk 5): same file — stale-session guard on both
    `getPreferences` and `updatePreferences`. The
    `updatePreferences` test additionally asserts no ghost row got
    written so a future regression that drops the guard can't
    silently start inserting orphans.
  - +0: UI / theme / wiring chunks. The new section components
    are pure presentation + form state; the contracts they
    depend on (`updatePreferences`, `next-themes`'s `setTheme`)
    are already covered.

Total test count by chunk:

  - End of Day 24: 636
  - After Chunk 1 (UI only): 636 (+0)
  - After Chunk 2 (SSR only): 636 (+0)
  - After Chunk 3 (DB + actions): 645 (+9)
  - After Chunk 4 (UI only): 645 (+0)
  - After Chunk 5 (hotfix): 647 (+2)

## Followups for Day 26+

**From this session:**

1. **Persist Profile fields to the `users` row.** Name + phone
   are local-state-only today; need a `users` row update action
   with email-change verification flow. Phone doesn't exist on
   the `users` table yet — micro-migration to add it.

2. **`organizations` table + Organization-section persistence.**
   Org details are mock-saved today. Schema work: `id`, `name`,
   `industry`, `address`, `contact_email`, `contact_phone`,
   plus an FK from `users.organization_id` (nullable for
   admin/staff who don't belong to an org). Settings page only
   shows the section to admin/staff; the action needs to
   re-validate role server-side.

3. **Avatar uploads.** Profile section shows initials fallback
   today. Avatar uploads via R2 presigned URL would slot in
   cleanly — would need a small `avatarKey` column on `users` +
   the existing `r2.ts` helper.

4. **2FA enrolment.** Security section has a "Coming soon"
   placeholder. The flow needs a TOTP secret column on `users`,
   QR-code component, backup-codes table, the works. A whole
   chunk on its own.

5. **Real "active sessions" list + "Sign out everywhere".** The
   Security section's "Sign out everywhere" button currently
   just calls the local `logout` action. A real implementation
   would need a `sessions` table (we're stateless JWT today) so
   we can revoke individual sessions and surface a "Last seen on
   X device from Y city" list.

6. **Wire `density` + `reducedMotion` into actual UI density.**
   The preferences are persisted and the `<html>.dataset` hooks
   are set on mount, but nothing in the rest of the app reads
   them yet. Quick scan: tables would shrink row padding to
   `py-2`, cards to `gap-2`, etc. Multiple CSS rules under
   `[data-density="compact"]` in `globals.css`.

7. **Theme picker preview on `/login`.** Once a theme is
   selected, a logged-out visitor on `/login` does see the right
   palette (cookie carries it). But a first-time visitor has no
   way to preview palettes before signing in. Minor — a
   per-domain default could be configured later if a customer
   asks.

8. **Persist `lastSeenAt` on each preferences read.** Cheap
   liveness signal — would let us answer "how many active users
   in the last 7 days?" without touching the audit log. Trivial
   to add but worth a deliberate flip.

9. **Auto-redirect to `/login` on stale-session error.** Chunk 5's
   guard returns a clean `{ ok: false, error }` and the toast
   surfaces the wording, but the user still has to find the
   sign-out button themselves. A client-side helper that matches
   on the `STALE_SESSION_ERROR` string and calls `router.push(
   '/login')` (plus a `destroySession` call to clear the bad
   cookie) would close the loop. ~1 file, ~20 lines.

10. **Promote the user-existence guard out of `lib/preferences`.**
    The pattern from Chunk 5 (verify `users.id` exists before
    inserting a user-keyed row) will apply verbatim to every
    future module that adds a user-FK'd table — avatars, sessions
    inventory, 2FA enrolment, saved-report-configs. Extract into
    `lib/auth/session.ts::assertUserExists(userId)` or a similar
    leaf helper so future modules don't reimplement it (and don't
    forget to). 30-minute refactor when the second consumer arrives.

**Carried forward from earlier days (unchanged):**

11. Resend email on compliance state change (Day-23 followup #3).
12. Public registration UX / CAPTCHA / rate limiting (Day-15).
13. Real Consultway logo on the PDF cover.
14. Real R2 fixture files (Day-21 followup #3).
15. Realistic Indian-flavoured fixture data (Day-21 followup #2).
16. Searchable typeahead selects on forms + reports pickers.
17. Compliance state-transition history widget (Day-23 #2).
18. Bulk-transition action for admins (Day-23 #5).
19. Per-document CSV export / Bulk CSV import / Saved-report-
    config persistence / deleteProject / Project-attached
    documents / Side-by-side detail view / TransactionType badge
    palette unification / session invalidation on password reset
    / public tender browsing / OpenNext install / D1 client
    factory / Resend domain verification / Real Cloudflare bucket
    UUIDs / Hoist escapeHtml. All Day-15 or earlier carry-
    forwards.

## Carry-forward to Day 26

- **Nothing pushed to `origin/dev` yet.** Every chunk this session
  was held locally for review — no rolling-push pattern this
  time. `origin/dev` still ends at `556f840` (the Day-24 report
  commit). The Day-25 work is one big working-tree change you can
  inspect via `git status` / `git diff`.
- **647 tests passing on every run.** One new test file added
  (`lib/preferences/__tests__/actions.test.ts`, 11 tests — 9 from
  Chunk 3, +2 from the Chunk 5 stale-session hotfix).
- **Schema migration 0014 applied to the local DB.** Production
  D1 / staging untouched — would need a deploy session for that.
- **Two new dependencies**: `motion ^12.40.0` (~30 KB gz) and the
  new shadcn primitives (`tabs`, `avatar`, `separator`,
  `radio-group`, `dropdown-menu` — no runtime deps, just files in
  `components/ui/`).
- **`pnpm db:seed`** continues to land every row as `unchanged`
  against the existing dev DB — the new `user_preferences` table
  is intentionally empty (lazy creation per user on first save).
- **`pnpm seed:verify`** clean — no invariants reference the new
  table.
- **`pnpm cron:*`** all unchanged — Day 25 didn't touch crons.
- **The `cw-theme` cookie is the contract for SSR theme.** If
  another module ever needs to know the user's palette server-
  side (e.g. PDF export, transactional email), `lib/themes-cookie.ts`
  is the place to import from.
- **The theme catalog (`lib/themes.ts`) is the source of truth.**
  Add a new palette there + the matching `.theme-<id>` block in
  `app/globals.css`. The provider, the picker, the sidebar
  dropdown, the Zod validator — all five auto-pick it up via
  `THEME_IDS`.
- **`updatePreferences` is patch-shaped, not full-row.** Future
  consumers (`localeSection` if we add one, "default landing
  page" picker, per-module table density overrides) just add the
  column + extend the Zod schema; no action-layer rewrites.
- **Manual browser pass on the Settings page + theme system
  deferred to Mayuresh.** Builds clean, type-check clean, full
  test suite green, but the framer-motion section transitions,
  the no-flash SSR claim, and the sidebar dropdown all need a
  real browser to verify.

That's Day 25.
