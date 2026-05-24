# Day 27 — verification + carry-forward queue: SSR prefs, auth helper, profile name, login theme picker

_Date: 2026-05-24_

## Scope

Two phases. First, manual browser pass on Day-26 work — every item
on the 11-point checklist (sidebar pill animation, mobile drawer,
login gradient + fade-up, PasswordInput Eye toggle, theme cycle
re-tint, toast dedupe, density + reduced-motion toggles, page
transitions, toast aesthetic across 6 palettes) verified live in
the browser via the Preview MCP. One real defect surfaced; ten
items behaved exactly as the Day-26 report described.

Second, four ordered fixes — three from the Day-26 followup list
plus the defect found in phase one. All four landed sequentially
with type-check, scoped tests, and a final production build clean.

Four items, in order:

1. **NEW — SSR-emit `data-density` + `data-reduced-motion`.**
   Closes the defect Phase-1 surfaced: the two attrs were only
   written by `AppearanceSection`'s client `useEffect`, so any
   full page reload outside Settings dropped them until the user
   re-visited that section. Fix: read user prefs server-side in
   the root layout, emit on `<html>` alongside `data-theme`.
   Unauthenticated pages (/login, /register) skip the DB read.

2. **A — Promote `assertUserExists` to `lib/auth/session.ts`.**
   Day-25 followup #10. The user-existence check was inlined as
   `userExists` in `lib/preferences/actions.ts`; extracted into a
   shared `assertUserExists(userId)` helper that fail-closes on
   any DB error and carries full JSDoc on the stale-session use
   case. Existing preferences tests stayed green after a one-line
   `vi.mock` adjustment (use `importOriginal` so `assertUserExists`
   exercises the real DB while `readSession` stays controllable).

3. **B — Real Profile name persistence.** Day-26 followup #3.
   Replaced the setTimeout stub in `ProfileSection` with a real
   `updateProfile({ name })` Server Action. Strict Zod schema
   (rejects unknown extra keys at runtime), stale-session guard
   via the new helper from item A, no-op short-circuit (re-saving
   the same name doesn't write or audit), audit event on real
   change with before/after snapshots scoped to the name column.
   9 new integration tests; 20 total green across `lib/preferences`
   + `lib/profile`. Email / phone / jobTitle stay cosmetic this
   round (phone needs a column migration, email needs a verify
   flow); deliberate scope cut documented in the action's
   docstring.

4. **G — Theme picker on /login + /register.** Day-26 followup
   #7. With the gradient backdrop tracking the cookie palette,
   first-time visitors had no way to preview before signing in.
   New shared `ThemePickerList` component extracts the swatch-row
   rendering used by both the in-app `user-pill.tsx` quick-
   switcher AND the new `ThemePickerDropdown` mounted in the
   corner of /login and /register. Picker is cookie-only — no
   DB persist (user isn't signed in), the gradient re-tints
   immediately, the choice survives to first paint after sign-in
   via the existing `cw-theme` cookie SSR-read.

End-of-day verification: `pnpm exec tsc --noEmit` silent after
every item; `pnpm test --run lib/preferences lib/profile`
**20/20 green** (11 existing preferences tests + 9 new profile
tests); `pnpm build` clean (26/26 pages); browser walk-through
confirmed all four landings work end-to-end (SSR attrs persist
across full reload, audit row written for name change, gradient
re-tints on picker selection, etc.).

No new dependencies. No schema migrations.

## What shipped

### Item NEW — SSR-emit density + reduced-motion (closes Phase-1 defect)

**Symptom found in Phase 1.** Toggled Density → compact in
Settings; tables tightened. Hit F5 on `/dashboard/companies`;
tables snapped back to comfortable. Visited Settings; the radio
still showed compact selected. Defect: the `data-density` attr
was on `<html>` from `AppearanceSection`'s client useEffect, so
a full reload (which never touches `AppearanceSection`) dropped
it.

**Root cause.** `app/layout.tsx` correctly emitted `data-theme`
SSR-side from the `cw-theme` cookie — but `data-density` and
`data-reduced-motion` had no SSR writer. They lived only in the
client useEffect inside `AppearanceSection`, which means they
were "in-session" attributes: persisted in DB, applied via the
useEffect on Settings visit, persisted across SPA navigation
(React preserves the doc), but lost on every hard reload until
the user re-visited Settings to re-trigger the effect.

**Fix.** Read the user's persisted preferences in the root
layout server-side, emit both attributes on `<html>` alongside
`data-theme`. Unauthenticated callers (every public page) skip
the DB read entirely — these attrs are dashboard-affordance
hints with no meaning before sign-in.

**New helper.** [lib/preferences/server.ts](../../lib/preferences/server.ts) —
`getPreferencesForSSR(userId)`. Thinner than `getPreferences()`
because the caller already has a userId (no session round-trip
needed) and there's no stale-session guard (the layout already
gated on `readSession`). Critically, **never throws and never
returns null** — any DB hiccup falls back to the defaults shape,
so a preferences read never blocks a render.

Why a separate module instead of exporting from
`lib/preferences/actions.ts`: the actions module is `"use server"`,
which means every exported symbol becomes a remote-call stub on
the client. The SSR reader needs to be importable from a Server
Component without that transform. Splitting them keeps the
Server Action surface clean and lets the SSR reader stay a leaf
that any layout / Server Component can pull in.

**Root layout wiring.** [app/layout.tsx](../../app/layout.tsx)
now reads `readSession()` after the cookie read, fetches prefs
when a session exists, and emits:

```jsx
<html
  data-theme={initialTheme}
  data-density={prefs?.density ?? undefined}
  data-reduced-motion={prefs?.reducedMotion ? "true" : undefined}
>
```

The `?? undefined` (not `?? ""` or a literal "comfortable") means
the attr is omitted entirely for unauthenticated callers — the
default CSS rules (no `[data-density]` selector match) apply,
which is exactly the comfortable layout. Same shape for
reduced-motion: only present on `<html>` when the user has it on.

**Why root layout, not dashboard layout.** Considered scoping the
SSR read to `app/dashboard/layout.tsx` since density only matters
inside the dashboard. Decided against: it would put the SSR attr
on a `<div>` deep inside the body, and the existing client
useEffect writes to `<html>`. Two writers, two locations, equal
CSS specificity → last-applied-wins, which is fragile. Putting
both writers on `<html>` keeps the contract simple — one
canonical attribute location, server emits it on first paint,
client useEffect updates it on toggle, both agree on where it
lives.

**Verification:** Full reload to `/dashboard/companies` (a page
that never mounts `AppearanceSection`) → `data-density="compact"`
present on `<html>` from SSR → table cells render at 6px instead
of 8px. Defect closed.

### Item A — Promote `assertUserExists` to lib/auth/session.ts

Day-25 followup #10. The helper was inlined as
`userExists(userId)` inside [lib/preferences/actions.ts](../../lib/preferences/actions.ts)
since the Day-25 stale-session work; extraction was deferred to
the day a second consumer needed it. Item B in this session is
that second consumer, so doing the extraction first means B can
import it directly rather than copy-pasting.

**New exported helper.** [lib/auth/session.ts](../../lib/auth/session.ts) —
`assertUserExists(userId): Promise<boolean>`. Full JSDoc covering
the stale-session use case (cookie verifies cleanly but the
userId no longer maps to a row), the FK-fault failure mode it
defends against, and an `@example` showing the typical caller
shape. Wrapped in try/catch so any DB error fails closed
(returns `false`) — better to surface a stale-session toast
than to proceed and FK-fault one query later.

The new imports in `lib/auth/session.ts` (`eq` from drizzle-orm,
`db` from `@/lib/db`, `users` from `@/lib/db/schema`) are the
first DB-touching imports in that module — until now `session.ts`
was a pure crypto / cookie module. The addition feels in-place
rather than scope-creep because the helper is fundamentally an
auth concern (validating the auth identity) that happens to be
implemented as a DB lookup.

**Caller swap.** [lib/preferences/actions.ts](../../lib/preferences/actions.ts)
imports `assertUserExists` alongside `readSession` from the same
module, deletes the local `userExists` helper (-9 LOC including
the docstring), and updates both call sites
(`getPreferences` + `updatePreferences`). Net diff: -1 helper,
+1 import, identical behaviour.

**Test mock update.** The preferences tests previously had
`vi.mock("@/lib/auth/session", () => ({ readSession: vi.fn(…) }))`
which would now silently drop `assertUserExists`. Updated to use
`importOriginal`:

```ts
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    readSession: vi.fn(async () => null),
  };
});
```

The real `assertUserExists` now runs against the test DB — which
is what the existing "ghost session" tests actually wanted all
along. The ghost userId is never inserted into the test fixture,
so `assertUserExists` naturally returns false and the action
returns the friendly stale-session error. Tests pass without
any behavioural changes — the mock update is purely a side effect
of the helper moving modules.

### Item B — Real Profile name persistence

Day-26 followup #3. The `handleSave` in
[profile-section.tsx](../../app/dashboard/settings/_components/profile-section.tsx)
was a `setTimeout` + toast — the "fake feature" critique from
Day 25 #1 (and tagged as such in `<notes>` block of every Day-25
verification) finally closes.

**New module.** [lib/profile/](../../lib/profile/) with the
standard four-file shape:

- **`schemas.ts`** — `updateProfileSchema` (Zod). Single field
  `name` with min 2 / max 120 / trimmed bounds, mirroring the
  `userName` field in `lib/auth/schemas.ts::registerCompanySchema`
  (the user already passed this envelope at registration so the
  same shape is the right contract for edits). `.strict()` means
  unknown keys are rejected — a client trying to sneak `phone`
  fails loudly rather than silently being ignored.

- **`actions.ts`** — `updateProfile({ name })` Server Action.
  Pipeline: read session → guard stale via `assertUserExists`
  (the helper from item A) → validate via Zod → read existing
  name for audit before/after → short-circuit on no-op (saving
  the same name) → UPDATE `users.name` → emit audit event →
  return new name.

  Audit logging is ON for this action even though preferences
  deliberately don't audit. Name is identity-adjacent — admins
  should be able to answer "who changed this user's display name
  and when?" during an incident. The before/after snapshots
  capture only the single field touched, not the whole user row.

- **`__tests__/actions.test.ts`** — 9 integration tests
  mirroring the preferences pattern: unauth, stale-session,
  success persists + bumps updatedAt, trim normalisation,
  too-short / too-long rejection with `field: "name"` hint,
  strict-key rejection at runtime, no-op skip (no write, no
  audit), audit event shape on real change. All 9 green.

  One test caught a timestamp parsing quirk: the seeded
  `users.updatedAt` uses SQLite's `datetime('now')` default (no Z
  suffix → `new Date()` parses as LOCAL time), while the
  `$onUpdate` hook writes `new Date().toISOString()` (with Z →
  UTC). In a non-UTC timezone, comparing the two gives a
  6-hour-off result. Fix: establish the baseline timestamp via a
  first `updateProfile` call so both timestamps are ISO format,
  apples-to-apples. Documented in the test for any future
  copy-pasters.

**Plumbing.** [app/dashboard/settings/page.tsx](../../app/dashboard/settings/page.tsx)
now reads `users.name` (one indexed lookup keyed on user id) and
passes `initialName` through.
[settings-shell.tsx](../../app/dashboard/settings/_components/settings-shell.tsx)
accepts + forwards. ProfileSection swaps `useState` for a
`useState` baseline that advances on successful save (so the
save bar collapses), wires `useTransition` instead of the
ad-hoc `isSaving` boolean, and honours `isStaleSessionError`
+ `buildStaleSessionRedirectUrl` for the same reason the
appearance / notifications sections do.

**Scope cuts documented in the action's module docstring.**
- Phone → no column on `users` (micro-migration deferred).
- Email → change needs a verify-old + verify-new flow (out of
  scope without explicit approval).
- jobTitle → purely decorative, no persistence target yet.

The three fields stay rendered in the form so the layout doesn't
feel broken; the user can type into them but only `name` is
persisted on save. The save indicator only lights up on a `name`
change, not on the cosmetic fields.

### Item G — Theme picker on /login + /register

Day-26 followup #7. The new gradient backdrop tracks the
`cw-theme` cookie SSR-side, so returning visitors land on their
picked palette — but a first-time visitor sees Warm Ambient
(the default) with no way to preview alternatives before
signing in.

**Shared swatch list.** [components/theme-picker-list.tsx](../../components/theme-picker-list.tsx) —
handler-agnostic list of 6 `DropdownMenuItem` rows. Each row
renders the tiny swatch trio (palette indexes 0/2/3 — the most
recognisable spread across all 6 palettes), the palette name,
and an active checkmark. Consumers pass `activeThemeId` +
`onSelect`; the list doesn't know whether the handler writes
to the DB, the cookie, or both.

**Login dropdown.** [components/theme-picker-dropdown.tsx](../../components/theme-picker-dropdown.tsx) —
a complete standalone dropdown wrapping the list. Small
`Palette`-icon trigger button absolutely-positioned at top-right
(overridable via `className` prop). The handler writes the
`cw-theme` cookie directly using `buildThemeCookieString` —
not via the `updatePreferences` Server Action, which would
reject the unauthenticated caller anyway. Once the user signs
in, AppearanceSection persists their NEXT theme change through
to the DB; the cookie carries them to first paint either way.

Writing the cookie immediately on click (rather than relying on
`<ThemeCookieSync>` to mirror it on next render) defends against
the "race between client write and full navigation" footgun
that bit us in Day-26's stale-session work. A user who clicks
a palette then immediately hits F5 still sees the new value
SSR-side.

**user-pill refactor.** [components/dashboard/user-pill.tsx](../../components/dashboard/user-pill.tsx)
now consumes `ThemePickerList` instead of rendering the swatch
rows inline. The wrapping dropdown structure (Settings →
separator → Theme label → swatch list → separator → Sign out)
stays under user-pill's control — only the swatch markup is
shared. Net behaviour unchanged; ~45 LOC of JSX deleted from
user-pill, replaced by a 4-line `<ThemePickerList>` invocation.

**Mounts.** [app/login/page.tsx](../../app/login/page.tsx) and
[app/register/page.tsx](../../app/register/page.tsx) both mount
`<ThemePickerDropdown />` once inside the `<main>` (above the
animate-fade-up form container). The picker's absolute-top-right
position doesn't collide with either page's layout — both forms
center on the viewport, the picker floats free in the corner.

## Key decisions

**SSR attrs on `<html>` (root layout), not on the dashboard
content div.** The client useEffect in AppearanceSection writes
`document.documentElement.dataset.density` — so the SSR writer
needs to target the same node, otherwise we'd have two writers
producing two attr locations with equal CSS specificity. Root
layout pays one cheap DB lookup per authenticated page render;
unauthenticated callers skip the read entirely. The trade-off
is one indexed lookup per request, which the perf budget can
absorb at our scale.

**Skip the DB read for unauthenticated callers.** The simplest
implementation would be "always read prefs"; we instead branch
on `session ?? null` and only read when a session exists. Saves
a DB round-trip per /login or /register render — those pages
get hit by every bounced unauthenticated visitor, so the
cumulative saving is worth a one-line conditional. The CSS
falls back to defaults (no `[data-density="compact"]` match →
comfortable layout) which is exactly the right behaviour for
public pages.

**`getPreferencesForSSR` never throws, never returns null.**
The actions-layer `getPreferences` returns `{ ok: false }` on
failure paths (unauthenticated, stale session) so the caller can
branch. The SSR variant has no such caller — the layout can't
"branch" on a missing preferences read, it has to render
something. So the SSR helper falls back to defaults on any error
(logged via `logger.warn` so the failure stays observable) and
the caller never has to handle a null case. One less branch in
every layout that uses it.

**Separate `lib/preferences/server.ts` instead of exporting from
`actions.ts`.** The actions module is `"use server"` — every
export becomes a remote-call stub on the client. The SSR
variant has to be importable from a Server Component without
that transform. Splitting them keeps the Server Action surface
clean (only the things meant to be called from client code are
there) and lets the SSR reader stay a leaf with no upward deps.

**`assertUserExists` lives in `lib/auth/session.ts`, not its
own file.** Considered `lib/auth/user-exists.ts` for one-purpose
modularity. Decided against — the helper is fundamentally an
auth concern (validating the auth identity), and `session.ts`
already exports the rest of the auth read API (`readSession`,
`verifySession`, `destroySession`). Adding `assertUserExists` to
that module keeps the auth API discoverable from one import.

**`assertUserExists` fails closed.** The implementation wraps
the SELECT in try/catch and returns `false` on any error. A DB
hiccup mid-call surfaces as "stale session" to the user (toast +
redirect to /login) rather than letting the action proceed with
a dead userId and FK-fault one query later. The trade-off is
that a transient DB blip during the existence check forces a
sign-in, but transient blips that affect this query would have
broken the next query too — the fail-closed behaviour just
makes the failure surface earlier and friendlier.

**Profile name only — phone, email, jobTitle deferred with
documented scope cuts.** Resisted the urge to "while you're in
there" the rest of the Profile fields. Phone needs a column
migration. Email change needs a verify-old + verify-new flow
(security-critical, can't be ad-hoc). jobTitle has no real use
case beyond display. The narrow scope means item B was ~2 hours
instead of half a day, and the next session can pick up
phone (small migration + form wiring) without inheriting any
half-implemented state.

**`useState` baseline + `useTransition`, not optimistic update.**
Considered an `useOptimistic` flow for the name save. Decided
against for two reasons: (1) the save round-trip is ~50ms on
local dev and probably <300ms in production, so optimistic UI
saves <1 frame of perceived latency; (2) the rollback path on
failure is harder to reason about than a simple "transition
pending → result → advance baseline or roast on error" flow.
useTransition pattern matches what AppearanceSection and
NotificationsSection already use, so the three sections stay
consistent.

**Shared swatch list (`ThemePickerList`), not a shared full
dropdown.** Considered extracting the entire dropdown so the
two consumers (`user-pill.tsx` and `theme-picker-dropdown.tsx`)
share a single React component. Decided against — the two
surfaces have different siblings inside their dropdown
(user-pill has Settings + Sign out around the theme group; the
login picker has nothing else). Extracting the whole dropdown
would force one of them into the other's shape. Extracting just
the swatch list keeps the surrounding chrome under each
consumer's control while still deduping the per-row markup.

**Login picker writes cookie directly, not via
`updatePreferences`.** The Server Action would reject the
unauthenticated caller. The cookie alone is enough — the
gradient re-tints immediately (CSS vars + ThemeProvider read
the cookie / localStorage on next render), and the user's next
sign-in inherits the cookie SSR-side. Once signed in,
AppearanceSection writes the next theme change through to the
DB on the user's behalf. No reason to special-case persistence
for the unauthenticated picker.

## Gotchas surfaced

**`data-density` set via useEffect doesn't survive a hard
reload.** This is the entire shape of the defect found in
Phase 1 above. Any future user-preference attribute that needs
to be present on first paint MUST be written from the SSR
layer, not only from a client useEffect. Adding the SSR writer
in root layout is the contract now; any new
preference-driven attribute should follow the same pattern.

**Mocking a module after extracting a helper into it requires
`importOriginal`.** The default `vi.mock(path, () => ({...}))`
form completely replaces the module — any newly-added export
that the consuming module imports breaks at runtime with
"No 'X' export is defined on the mocked module." The fix is
`vi.mock(path, async (importOriginal) => { const actual = await
importOriginal(); return { ...actual, mocked: vi.fn() }; })`.
Worth remembering for any future "extract a helper into an
already-mocked module" refactor.

**SQLite `datetime('now')` defaults don't include the Z suffix.**
SQLite returns `"2026-05-24 21:40:04"` (no T separator, no
timezone) while `new Date().toISOString()` returns
`"2026-05-24T21:40:04.074Z"`. When you parse both with
`new Date(...)`, the first is interpreted as LOCAL time and the
second as UTC — in a UTC-6 timezone, the local-parsed timestamp
is 6 hours AHEAD of where you'd expect. This bit the profile
test's "updatedAt bumps" assertion; the fix was to establish
the baseline via an initial UPDATE so both timestamps come from
`$onUpdate` ISO format. Any future "compare seeded timestamp
vs application-set timestamp" test has the same trap.

**Strict Zod schema (`{}.strict()`) rejects unknown keys at
runtime, but the matching compile-time check fires at the
TypeScript layer too.** The test that wanted to verify the
runtime rejection had to cast (`as unknown as { name: string }`)
to bypass the TS check. `@ts-expect-error` couldn't sit on the
right line because the error fires on the field declaration
inside the literal, not on the call. Casting through `unknown`
is the cleaner contract for "yes I'm intentionally passing the
wrong shape, prove the runtime catches it."

**Conditional `data-*` attribute emission.** React renders
`data-foo={undefined}` as no attribute at all (correct), but
`data-foo={null}` or `data-foo={false}` would render as
`data-foo="false"` (string), which would match a `[data-foo="false"]`
selector if one ever existed. Using `?? undefined` (not
`?? null` or `?? ""`) for the conditional attrs in root layout
keeps the absent case truly absent, not a stringified false.

**`window.location.assign` triggers a full page reload
including the root layout — which now reads prefs.** Confirmed
the new SSR prefs read in root layout doesn't break the
stale-session redirect flow: `window.location.assign` to
`/auth/clear-session` triggers a full reload, the clear-session
handler deletes the cookie, the redirect to `/login` arrives at
the root layout with no session — `readSession()` returns null,
the prefs branch short-circuits, layout renders the default
shape. No new failure mode.

## Surfaces touched

```
# Item NEW — SSR-emit density + reduced-motion
lib/preferences/server.ts                                          (new — SSR-safe prefs reader)
app/layout.tsx                                                     (modified — emit data-density + data-reduced-motion on <html>)

# Item A — Promote assertUserExists
lib/auth/session.ts                                                (modified — new assertUserExists export + JSDoc)
lib/preferences/actions.ts                                         (modified — drop local userExists, import shared helper)
lib/preferences/__tests__/actions.test.ts                          (modified — vi.mock importOriginal pattern)

# Item B — Real Profile name persistence
lib/profile/schemas.ts                                             (new — updateProfileSchema)
lib/profile/actions.ts                                             (new — updateProfile Server Action)
lib/profile/__tests__/actions.test.ts                              (new — 9 integration tests)
app/dashboard/settings/page.tsx                                    (modified — read users.name, pass initialName)
app/dashboard/settings/_components/settings-shell.tsx              (modified — accept + forward initialName)
app/dashboard/settings/_components/profile-section.tsx             (modified — real updateProfile call + useTransition)

# Item G — Theme picker on /login + /register
components/theme-picker-list.tsx                                   (new — shared swatch-row component)
components/theme-picker-dropdown.tsx                               (new — standalone dropdown wrapper)
components/dashboard/user-pill.tsx                                 (modified — consume ThemePickerList)
app/login/page.tsx                                                 (modified — mount picker)
app/register/page.tsx                                              (modified — mount picker)

# Tooling
.gitignore                                                         (modified — ignore .claude/launch.json + settings.local.json)

# Day 27 report
docs/reports/day-27-report.md                                      (new — this commit)
```

7 new files + 9 modified = **16 unique surfaces touched** across
4 items + tooling + report.

## Test totals

Before Day 27: **647 tests across 34 files** (Day 26 end state).
After Day 27: **656 tests across 35 files** — +9 tests, +1 file.

The 9 new tests live in
[lib/profile/__tests__/actions.test.ts](../../lib/profile/__tests__/actions.test.ts):

```
updateProfile
  ✓ returns { ok: false } when unauthenticated
  ✓ returns a friendly error when the session points at a missing user
  ✓ persists the new name and bumps updatedAt
  ✓ trims whitespace before persisting
  ✓ rejects a name that's too short with field: 'name'
  ✓ rejects a name that's too long with field: 'name'
  ✓ rejects unknown extra keys (strict schema)
  ✓ short-circuits on a no-op (same name) without writing or auditing
  ✓ emits an audit event on a real change with before/after snapshots
```

The 11 existing preferences tests stayed green after item A's
`vi.mock` refactor (`importOriginal` pattern). Net green delta:
+9. Two test files touched today, both at full pass.

`pnpm build` clean throughout — six runs across the four items'
checkpoints, all green.

## Followups for Day 28+

**From this session:**

1. **Phone column on `users` + Profile phone field wiring.**
   Profile section currently has a phone input that types into
   local state but doesn't persist. Adding a `phone TEXT NULL`
   column on `users` (micro-migration), extending
   `updateProfileSchema` to accept the field, and letting
   `updateProfile` write it through is ~1 hour. No verification
   flow needed — phone isn't an authentication factor today.

2. **Email-change flow.** Out of scope this round because email
   IS an authentication factor — changing it needs a verify-old
   + verify-new round-trip with email tokens. Half-day feature
   on its own.

3. **jobTitle persistence.** Decorative field with no real use
   case yet. Defer until a downstream feature actually needs to
   display "Project Manager" / "Civil Engineer" / etc.

4. **Test the SSR prefs reader.** `getPreferencesForSSR` is
   exercised end-to-end by the browser walk-through but doesn't
   have a unit test. ~20 min: cover the happy-path read, the
   missing-row default fallback, and the DB-error default
   fallback. Worth adding when the next pref-related work
   touches that file anyway.

5. **Theme picker on `/forgot-password` and `/reset-password`.**
   Two more unauthenticated entry points that have the same
   gradient backdrop but no picker. ~10 min each — drop the
   same `<ThemePickerDropdown />` mount. Defer to a future
   "auth pages consistency sweep" rather than tacking onto
   this one.

**Carried forward from earlier days (unchanged):**

6. Avatar uploads via R2 (Day-26 #5). Still needs `avatarKey`
   column migration approval.

7. Command palette / Cmd+K (Day-26 #6). Half-day on its own.

8. Organizations table + Org section persistence (Day-26 #4 /
   Day-25 #2). Half-day, schema migration.

9. Quick-filter chips on list pages (Day-26 #9). ~1-2 hr per
   list page; demand-driven.

10. Inline edit on detail pages (Day-26 #8). Half-day per
    entity, app-wide UX shift.

11. 2FA enrolment (Day-25 #4). Whole module.

12. Real "active sessions" list (Day-25 #5). Needs a `sessions`
    table — we're stateless JWT today.

13. Resend email on compliance state change (Day-23 #3).

14. Public registration UX / CAPTCHA / rate limiting (Day-15).

15. Real Consultway logo on the PDF cover.

16. Real R2 fixture files (Day-21 #3).

17. Realistic Indian-flavoured fixture data (Day-21 #2).

18. Searchable typeahead selects on forms + reports pickers.

19. Compliance state-transition history widget (Day-23 #2).

20. Bulk-transition action for admins (Day-23 #5).

21. Per-document CSV export / Bulk CSV import / Saved-report-
    config persistence / deleteProject / Project-attached
    documents / Side-by-side detail view / TransactionType
    badge palette unification / session invalidation on
    password reset / public tender browsing / OpenNext install
    / D1 client factory / Resend domain verification / Real
    Cloudflare bucket UUIDs / Hoist escapeHtml.

## Carry-forward to Day 28

- **All Day-26 + Day-27 work committed.** Two commits being
  pushed at end of day 27: the deferred Day-26 Chunk 6 (sidebar
  pill + login/register polish + mobile sidebar + Day-26 report)
  and the Day-27 batch (NEW + A + B + G + this report + the
  `.gitignore` update for `.claude/launch.json`).
- **Three Day-26 followups closed:** #3 (Profile name
  persistence), #7 (theme picker on /login + /register), and
  the SSR-density defect found during Phase-1 verification
  (which isn't on the original followup list — it surfaced
  today and was fixed today).
- **Day-25 followup #10 closed:** `assertUserExists` extracted.
- **656 tests passing.** +9 net (all from item B's new module).
- **Schema migrations: zero.** Day 27 was pure new actions +
  layout reads + small UI mounts.
- **New dependencies: zero.** `motion`, `sonner`, `next-themes`,
  shadcn primitives all already in the bundle. Three new
  components (`theme-picker-list`, `theme-picker-dropdown`,
  `lib/preferences/server.ts`) shipped as pure file adds.
- **`assertUserExists` from `lib/auth/session.ts` is the
  contract for "is this session's userId still real?"** Any
  future Server Action that takes the session userId and
  writes to a child table (e.g. an `avatars` table FK'd to
  users) should call this helper before the insert.
- **`getPreferencesForSSR` from `lib/preferences/server.ts` is
  the contract for "read prefs from a layout / Server
  Component."** Any future surface (e.g. email templates, PDF
  reports) that wants to render in the user's selected
  palette / density should pull from this module, not from
  the `"use server"` actions module.
- **`ThemePickerList` from `components/theme-picker-list.tsx`
  is the canonical 6-row swatch markup.** Any future surface
  that wants to offer palette selection (e.g. a future user
  invite email's "choose your theme" link, or an admin
  user-detail page) should consume this rather than
  re-rendering swatches inline.
- **Day-26 manual browser pass status: 10/11 items behaved
  exactly as the Day-26 report described.** The 11th
  (density toggle tightens tables) worked in-session but
  failed on hard reload — fixed today as item NEW.

That's Day 27.
