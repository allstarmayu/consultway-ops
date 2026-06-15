# Day 33 — in-app user management + email-invite onboarding

_Date: 2026-06-06_

## Scope

A full-feature day, chosen off the Day-32 queue: **in-app user
management UI** (Day-30 #2) paired with the **Resend** email path
(Day-30 #3). Two decisions were locked with Mayuresh up front via a
clarifying prompt:

1. **Onboarding model = email invite link.** Admin creates a user
   (email / name / role); the system mints an invite token and emails a
   "set your password" link. The invitee chooses their own credential.
   No plaintext password is ever handled by the admin.
2. **Scope = full feature this session** — list + detail + create/invite
   + edit + deactivate/reactivate + admin password-reset + resend-invite
   + nav + tests, plus the Resend doc.

The shape was: build the domain layer (guards → schemas → actions →
invite token → accept-invite) test-first, verify it green, then mirror
the **companies module** 1:1 for the UI, wire an admin-gated nav entry,
and bring the deployment doc current. Closed with a real browser
walk-through against the seeded dev DB.

**No database migration** — the `users` table already carried every
column the feature needs (`role`, `companyId`, `isActive` soft-disable,
`emailVerifiedAt`, `phone`, `jobTitle`). **No new dependencies** — the
tech stack is unchanged (Next 16 App Router, Drizzle, Zod 4, Resend SDK,
react-hook-form, shadcn/ui).

End-of-day state: feature complete and verified on `dev` (working tree,
**uncommitted** — `dev` still at `d909161`). tsc clean; **738 passing +
1 skipped across 41 files** (+41 tests / +3 files); `next build` green
with all 5 new routes in the manifest; browser-verified end-to-end
signed in as the dev admin.

## What shipped

### Item G — Shared auth guards (the small structural unlock)

`lib/auth/guards.ts` (NEW). The companies module (Day 2) had grown
private `requireAdmin` / `requireAdminOrStaff` helpers inline; the users
module needs the same gates. Lifted them into a shared, reusable home
exporting `requireAdmin`, `requireAdminOrStaff`, and the `Session` /
`AuthCheck` types. The `{ ok: false, error }` arm is a structural subset
of `ActionResult`, so an action can `return auth` directly.

(`lib/companies/actions.ts` still carries its own byte-identical copies —
deduping it to import from here is the queued mechanical follow-up,
deliberately left out of this diff to keep the feature change focused.)

### Item U — Users domain layer

- `lib/users/schemas.ts` (NEW) — `createUserSchema` (invite: no password
  field; enforces the role ↔ company invariant via `superRefine`),
  `updateUserSchema` (patch-style; email + isActive deliberately absent),
  `listUsersQuerySchema`, `userIdSchema`. The active-state filter is a
  `status` **enum** (`active`/`inactive`), not a coerced boolean —
  `z.coerce.boolean("false")` is `true`, which would have silently
  inverted the filter.
- `lib/users/actions.ts` (NEW) — `listUsers` (filters + search + sort +
  paginate, left-joins `companies.name`), `getUser`, `createUser`
  (+`createUserInternal` DI → mints invite + sends email),
  `updateUser`, `deactivateUser` / `reactivateUser`, `resetUserPassword`
  (+Internal DI), `resendInvite` (+Internal DI). All **admin-gated**,
  audited (`targetType:"user"`), with self-lockout guards (an admin
  can't change their own role away from admin, nor deactivate
  themselves).

### Item I — Invite token + acceptance (auth)

- `lib/auth/tokens.ts` — added `mintInviteToken` (72h TTL). An invite is
  mechanically a "set your initial password" link, so it reuses the
  `password_reset_tokens` table and the existing `consumePasswordResetToken`
  consume path — **migration-free**.
- `lib/auth/actions.ts` — added `acceptInvite`: validates against the
  reused `resetPasswordSchema`, consumes the token, writes the chosen
  hash, and additionally **flips `emailVerifiedAt`** (clicking a link
  sent to the address proves ownership — an invited user is verified the
  moment they accept). Audits `invite_accepted`.
- `lib/email/templates/user-invite.ts` (NEW) — `renderUserInviteEmail`,
  mirroring `password-reset-request.ts` (inline-styled, warm-ambient
  values verbatim, plain-text fallback).

### Item P — Admin user-management UI (mirrors companies 1:1)

- `app/set-password/{page,_components/set-password-form}.tsx` (NEW) —
  the public invite-acceptance landing, sibling of `/reset-password`.
- `app/dashboard/admin/users/` (NEW) — list `page.tsx` + `loading.tsx`
  + `error.tsx`; `_components/{filters-bar, users-table,
  users-table-section, badges}.tsx`. Filters: search (debounced) + role
  + status. Badges: `RoleBadge`, `AccountStatusBadge`,
  `InvitePendingBadge`.
- `app/dashboard/admin/users/new/page.tsx` (NEW) + shared
  `components/users/user-form.tsx` (NEW) — invite/edit form. The company
  picker shows only for the `company` role; the role select clears the
  company link when switched to admin/staff.
- `app/dashboard/admin/users/[id]/` (NEW) — detail `page.tsx` +
  `not-found.tsx` + `loading.tsx`; `_components/{user-header,
  user-overview, user-actions}.tsx` + `edit/page.tsx`. `user-actions`
  is the client panel: deactivate/reactivate, plus resend-invite (if
  unaccepted) or send-password-reset (if accepted), each toasting the
  outcome and `router.refresh()`ing.

### Item N — Navigation + audit widening + docs

- `components/dashboard/sidebar.tsx` — admin-only "Users" nav item
  (`adminOnly` flag + role filter in `SidebarContent`, covering desktop
  + mobile via the shared content component). Unlike the rest of the
  sidebar (shown to all, gated per-page), the admin section is hidden
  from non-admins so they aren't offered a link that just redirects.
- `components/audit/entity-history.tsx` — `targetType` prop union
  widened to include `"user"` (the audit layer + `resolveReferences`
  already handled user targets; only the component prop was narrower).
- `docs/09-deployment.md §3.5` — updated: invite/reset emails are now
  live through the same `sendEmail` path; added a quicker interactive
  smoke test (invite a user / send a reset) and a **heads-up that
  invite/reset links use `NEXT_PUBLIC_APP_URL`**, which must point at the
  actually-reachable origin or emailed links 404.

## Key decisions

**Email-invite onboarding over temp-password / admin-set-password.**
Most secure, ties into the Resend work, and the invitee never receives
a password from anyone. On staging without a verified domain the link
is still recoverable from the `[email stub] would send` log line, so
it's testable today. (Mayuresh chose this from a 3-option prompt.)

**Reuse `password_reset_tokens` for invites — no new table, no
migration.** Setting an initial password *is* a password reset. A
dedicated `invite_tokens` table would have been marginally cleaner
semantically but would have coupled the feature to a schema migration
(an approval gate) for no functional gain. Documented inline.

**Module is admin-only (stricter than the RBAC matrix).** The route
lives under `/dashboard/admin/*` and every action gates on `requireAdmin`.
`docs/08-rbac-matrix.md` permits staff to *read* users and to create
company-role users within companies they manage; that staff path is a
deliberate v1 follow-up. "When in doubt, deny."

**Audit lifecycle events fold into `created` / `updated` + metadata.**
Per the audit module's own documented verb rule ("X earns a verb only
if a verb-filtered feed will be needed"), deactivate/reactivate/
reset/resend record `updated` with `metadata.action`, not new verbs —
avoids touching the closed `AuditAction` union + its Zod twin + the
history renderer.

**Mirror the companies module rather than invent.** Same
page-shell-behind-Suspense + filters-bar + table + table-section
pattern, same `ActionResult` shape, same client-side `router.refresh()`
refresh convention (the codebase does **not** use `revalidatePath` —
caught and matched). The result reads as a native part of the app.

## Gotchas surfaced

**Zod 4's `.uuid()` validates the version/variant nibbles.** Hand-written
all-zeros UUIDs (`00000000-0000-0000-0000-0000000000a1`) are rejected
because the version nibble `0` isn't 1–8. Real `newId()` v7 UUIDs pass.
First test run failed 18 cases on this; fix was to generate ids via
`newId()` in tests. Schema is correct — the test data was wrong.

**`hashPassword` appends the pepper before bcrypt's 72-byte cap.** The
invited user's placeholder hash used a 64-hex-char random string; 64 +
the ~32-char pepper = 95 bytes > 72 → throw. Shortened the placeholder
to 16 bytes (32 hex, still 128 bits — and never matched anyway, since
the invite gate is the real barrier).

**`z.coerce.boolean("false") === true`.** Any non-empty string is
truthy, so a `?status=inactive` filter routed through a coerced boolean
would silently mean "active". Used a string enum for the active-state
filter instead.

**`revalidatePath` is not the codebase convention.** It appears in zero
existing actions — the app refreshes via client `router.refresh()` /
`router.push()` after an action resolves. Introducing `next/cache` would
also have broken tests (it's unmocked in `vitest.setup`). Stripped it.

**Importing a row type from a `"use server"` module is fine when
`import type`.** The table/header/overview server components import
`type { UserWithCompany }` from `lib/users/actions` — type-only imports
are erased before bundling, so no runtime "use server" value crosses the
boundary. The client form avoids it entirely by declaring its own
minimal `UserFormInitialValues`.

**Preview eval-context desync after client navigation.** During the
browser walk-through, `preview_eval` / `preview_fill` detached to a
stale `/dashboard` target after a router soft-nav, while
`preview_snapshot` / `preview_screenshot` tracked the live page. Render
verification (snapshots + screenshots) was solid; interactive
form-submit couldn't be driven — but that path is covered by the
integration tests (`createUserInternal` creates the row, mints the
invite, asserts the stub send).

## Surfaces touched

This session (working tree on `dev`, **uncommitted**):

```
lib/auth/guards.ts                                          (NEW — shared requireAdmin/requireAdminOrStaff + Session/AuthCheck)
lib/auth/tokens.ts                                          (modified — mintInviteToken, 72h, reuses password_reset_tokens)
lib/auth/actions.ts                                         (modified — acceptInvite)
lib/users/schemas.ts                                        (NEW)
lib/users/actions.ts                                        (NEW — list/get/create/update/deactivate/reactivate/reset/resend)
lib/email/templates/user-invite.ts                         (NEW)
lib/users/__tests__/schemas.test.ts                        (NEW — 13 cases)
lib/users/__tests__/actions.test.ts                        (NEW — 22 cases)
lib/auth/__tests__/invite.test.ts                          (NEW — 6 cases)
app/set-password/page.tsx                                   (NEW)
app/set-password/_components/set-password-form.tsx         (NEW)
app/dashboard/admin/users/page.tsx                         (NEW — list)
app/dashboard/admin/users/loading.tsx                      (NEW)
app/dashboard/admin/users/error.tsx                        (NEW)
app/dashboard/admin/users/_components/badges.tsx           (NEW)
app/dashboard/admin/users/_components/filters-bar.tsx      (NEW)
app/dashboard/admin/users/_components/users-table.tsx      (NEW)
app/dashboard/admin/users/_components/users-table-section.tsx (NEW)
app/dashboard/admin/users/new/page.tsx                     (NEW — invite)
app/dashboard/admin/users/[id]/page.tsx                    (NEW — detail)
app/dashboard/admin/users/[id]/not-found.tsx               (NEW)
app/dashboard/admin/users/[id]/loading.tsx                 (NEW)
app/dashboard/admin/users/[id]/edit/page.tsx               (NEW)
app/dashboard/admin/users/[id]/_components/user-header.tsx (NEW)
app/dashboard/admin/users/[id]/_components/user-overview.tsx (NEW)
app/dashboard/admin/users/[id]/_components/user-actions.tsx (NEW)
components/users/user-form.tsx                              (NEW — shared create/edit)
components/dashboard/sidebar.tsx                            (modified — admin-only Users nav)
components/audit/entity-history.tsx                         (modified — targetType union += "user")
docs/09-deployment.md                                       (modified — §3.5 invite/reset + APP_URL note)
docs/reports/day-33-report.md                              (NEW — this file)
```

~31 surfaces (27 new, 4 modified). No migration. No new deps.

## Test totals

Before Day 33 on `dev`: **697 passing + 1 skipped across 38 files**
(Day 32 end).
After Day 33 on `dev`: **738 passing + 1 skipped across 41 files**.

Added 3 test files / +41 tests (13 schema + 22 action + 6 invite), all
passing. The lone skip is the pre-existing Day-30
`lib/preferences/__tests__/server.test.ts` Proxy-spy case (still
queued).

`pnpm exec tsc --noEmit` clean. `pnpm build` green — `/set-password`,
`/dashboard/admin/users`, `/[id]`, `/[id]/edit`, `/new` all present in
the route manifest. Middleware confirmed: `/dashboard/admin/*` is
auth-gated; `/set-password` is public.

## Verification

Browser walk-through on the local dev server, signed in as
`admin@consultway.local` (seeded):

- **Login** → lands `/dashboard`. ✓
- **Users list** renders against the seeded roster: role pills
  (Staff/Company), joined company names ("—" for internal staff),
  status column showing Active / Disabled / stacked "Invite pending"
  (on the seeded unverified GreenTech user). Filters + admin-only nav
  item present. ✓
- **Invite form** renders with the conditional company picker (hidden
  for the default Staff role). ✓
- **Zero console errors.** Screenshot captured of the list. ✓

Interactive create-submit + the detail/deactivate/reset clicks weren't
driven in-browser (preview eval-context desync, see Gotchas) but are
covered by the integration tests + the build.

## Live URL + data state

Staging is unchanged (`d909161`) — this work is **not yet deployed**
(uncommitted on the `dev` working tree). On push to `dev`, CI + Deploy
Staging run automatically.

- **URL**: https://consultway-ops-staging.mayuresh-dongare.workers.dev
- Once deployed, the feature is reachable at `/dashboard/admin/users`
  for admin sign-ins.

## Followups for Day 34+

**From this session:**

1. **Resend go-live (the "real email" half).** Verify the sender domain
   + `wrangler secret put RESEND_API_KEY --env staging` (and prod) per
   `docs/09-deployment.md §3.5`. Until then invite/reset emails
   log-fallback — link recoverable via `wrangler tail`. **Mayuresh's
   DNS + secret time.**

2. **`NEXT_PUBLIC_APP_URL` for invite links.** Staging's var points at
   `staging.ops.consultway.info` (custom domain). If that's not live,
   emailed links 404 — repoint to the `*.workers.dev` URL or stand up
   the domain. (Touches `wrangler.jsonc` — needs an explicit OK.)

3. **Dedup the companies guards** — point `lib/companies/actions.ts` at
   `lib/auth/guards.ts` and delete its private copies. Safe, mechanical,
   test-covered. (In progress on the loop.)

4. **Staff user-management path** (RBAC 🟡 — staff create company-role
   users within companies they manage). Deferred v1 item.

5. **Browser-eyeball the detail + invite end-to-end on staging** once
   Resend is on (invite a real address → click link → set password →
   sign in).

**Carried forward (unchanged):**

6. G small-wins bundle: cron handler wiring (Day-30 #4) + the skipped
   `lib/preferences` Proxy-spy fix (Day-30 #5) + bundle-size CI step
   (Day-30 #7) + doc rewrite sweep (Day-30 #6).
7. PDF reports via Cloudflare Browser Rendering (Day-31 #5) — spike on
   `spike/pdf-react-worker`.
8. Cmd+K command palette (Day-26 #6), email-change flow (Day-27 #2),
   organizations table (Day-26 #4), 2FA (Day-25 #4), active-sessions
   list (Day-25 #5) — the long tail.

## Carry-forward to Day 34

- **User management is feature-complete on `dev` but UNCOMMITTED.** The
  working tree carries ~31 surfaces. Commit + push when ready (surface
  the file list + a `CONTRIBUTING.md`-style message for approval first).
- **`lib/auth/guards.ts` is the canonical role-gate home** for new
  modules. Import `requireAdmin` / `requireAdminOrStaff` from there.
- **Invites ride the `password_reset_tokens` table** via
  `mintInviteToken` + `consumePasswordResetToken`. No invite table.
- **The whole admin/users module is admin-only.** Staff/company hitting
  it redirect to `/dashboard`; the actions re-check server-side.
- **CLAUDE.md hard rules still hold** on `wrangler.jsonc` /
  `next.config.ts` / `package.json` deps. Followups #2 needs an OK.

## Addendum — adversarial review pass + hardening (same session)

After the feature landed, ran a 44-agent adversarial review workflow over
the working-tree diff (5 dimensions → 2 refute-by-default verifiers per
finding → synthesis): **19 findings, 10 confirmed, 3 uncertain, 6
rejected**. Acted on every confirmed item:

**Hardening (lib/users/actions.ts):**
- **Last-admin guard** — `updateUser` (admin demotion) and `setActive`
  (admin deactivation) now refuse when no other *active* admin remains
  (`anotherActiveAdminExists`). The self-lockout guard only covered the
  single-actor case; this closes the multi-actor zero-admins lockout.
- **resetUserPassword** now refuses un-accepted users (would void the
  invite token without flipping `emailVerifiedAt` → dead-end) and
  deactivated users; **resendInvite** refuses deactivated users.
- **updateUser** only re-validates company existence when the patch
  actually moves role/company — a pure profile edit of a company user
  whose company was deleted (FK SET NULL orphan) is no longer blocked.

**UX/a11y:**
- `/login` now shows an "Account activated" banner on `?invite=accepted`.
- Deactivate dialog copy corrected re: live-session validity.
- `aria-invalid` / `aria-describedby` wired onto the role + company
  `SelectTrigger`s (Controller children weren't receiving FormField's
  injected aria).

**Tests:** +34 cases — RBAC gate on all 8 actions, last-admin guard,
status/companyId filters + pagination, createUser fail-soft +
unusable-placeholder-hash, updateUser missing-company/no-op/orphan
branches, credential-action guards + audit metadata, and the
expired-invite-token branch.

**Also un-skipped** the lone skipped test
(`lib/preferences/__tests__/server.test.ts`, Day-30 #5) via a hoisted
pass-through module mock that forces `select()` to throw — exercising the
SSR try/catch without the Proxy-spy problem.

**Deliberately deferred (documented):** full live-JWT revocation on
deactivate/role-change (the pre-existing stateless-JWT limitation — needs
a `sessionVersion`/`passwordChangedAt` column + middleware work, and would
ripple into the companies test suite); and an `acceptInvite` isActive
check (negligible — `login()` already refuses inactive accounts).

**Post-addendum test totals:** **773 passing, 0 skipped across 41 files**
(first zero-skip suite since Day 30). tsc clean; `next build` green.
