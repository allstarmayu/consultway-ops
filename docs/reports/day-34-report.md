# Day 34 — landing the user-management feature + the staff path

_Date: 2026-06-15_

## Scope

Two halves:

1. **Land Day 33.** The whole in-app user-management feature (+ the
   adversarial-hardening addendum) had been sitting **verified but
   uncommitted** on the `dev` working tree, alongside two follow-ups that
   landed after the Day-33 report was written: the companies-guard dedup
   (Day-33 followup #3) and a docs sweep. Committed and pushed as three
   logical commits.
2. **Build the staff user-management path** (Day-33 followup #4). The
   module shipped **admin-only**; this wires the staff allowances from
   `docs/08-rbac-matrix.md § Users`.

The staff scope was **not** taken straight from the matrix. A short
clarifying exchange with Mayuresh reshaped it: his constraint was "admin
sees everything, staff should only see their own work." Since the schema
has **no per-staff company assignment** (staff carry no `companyId`; there
is no staff↔company link table), "their own work" had no schema meaning. A
three-option prompt resolved it to **"company accounts only"** — staff own
the *onboarding* lifecycle of company-role users, nothing internal.

**No database migration. No new dependencies.** Pure access-control +
role-aware rendering on top of the existing module.

End-of-day state: everything committed + pushed on `dev` (now at
`be7605b`). tsc clean; **778 passing across 41 files** (+5); browser-verified
across all three roles.

## What shipped

### Part A — Landing the Day 33 feature (3 commits)

Pushed `d909161..6ffee38`:

- **`429a9c3` feat(users): admin user management with email-invite
  onboarding** — the full Day-33 feature (31 files): domain layer
  (`lib/users/*`), invite token + `acceptInvite`, the `/set-password`
  landing, the `/dashboard/admin/users` UI mirrored 1:1 off companies, the
  shared `lib/auth/guards.ts`, the admin-only nav, and the addendum
  hardening (last-admin guard, credential-action guards, the `/login`
  activated-banner, the un-skipped preferences test).
- **`aba90bc` refactor(companies): use shared auth guards** — deleted the
  byte-identical private `requireAdmin` / `requireAdminOrStaff` / `Session`
  copies in `lib/companies/actions.ts` and pointed them at
  `lib/auth/guards.ts` (−52 lines). This was Day-33 followup #3.
- **`6ffee38` docs: document users module + Day 33 report** — the
  `06-api-reference.md § Users` surface, `08-rbac-matrix.md` note,
  `04-architecture.md`, `09-deployment.md §3.5`, and the Day-33 report.

### Part B — Staff user-management path (`be7605b`, 14 files)

**Access control (`lib/users/actions.ts`).** Four actions move from
`requireAdmin` to `requireAdminOrStaff`, each with a company scope for the
staff case:

- `listUsers` — for a staff caller, forces `role = "company"` (overriding
  any `role` query param), so the roster is company accounts only.
- `getUser` — returns the same "not found" for a staff caller hitting an
  admin/staff row, so internal accounts never leak (and the page
  `notFound()`s).
- `createUser` — refuses a staff caller inviting a non-company role
  (`{ ok: false, field: "role" }`).
- `resendInvite` — not-found for non-company targets when called by staff.

`updateUser`, `deactivateUser` / `reactivateUser`, and `resetUserPassword`
**stay `requireAdmin`** — the management lifecycle is admin-only.

**UI — role-aware rendering.**

- `components/dashboard/sidebar.tsx` — the `adminOnly` nav flag generalised
  to a `roles?: UserRole[]` allowlist; the Users item is
  `roles: ["admin", "staff"]`. Company-role users don't see it.
- List: `filters-bar.tsx` hides the role filter for staff (every row is a
  company user); `users-table.tsx` hides the per-row Edit action;
  `users-table-section.tsx` threads `viewerRole` through.
- Detail: `[id]/_components/user-header.tsx` hides the Edit button for
  staff; `user-actions.tsx` renders role-aware — staff get **resend-invite
  only** (and the panel returns `null` entirely for an already-activated
  user); `[id]/page.tsx` opens the gate to admin+staff and passes
  `viewerRole` / `canEdit`.
- Invite: `new/page.tsx` opens to admin+staff; `components/users/user-form.tsx`
  takes `viewerRole` and locks the role picker to "Company" (disabled,
  single option, with helper copy) for staff.
- The **edit page stays admin-only** (`updateUser` is admin-only) — a
  hand-typed `/[id]/edit` URL bounces staff. Defence in depth.

**Docs.** `08-rbac-matrix.md § Users` — staff List/Read/Create rows moved
from ✅/✅/🟡 to 🟡 (company-scoped), with the implementation note rewritten
for Day 33–34. `06-api-reference.md § Users` — rewritten to two access
tiers (admin vs the staff onboarding tier) with per-action gate labels.

**Tests (`lib/users/__tests__/actions.test.ts`).** +5 net. A new
staff-path suite asserts: list returns company-only, the `role` filter is
ignored for staff, getUser/resendInvite hide internal accounts, createUser
allows a company invite but refuses staff/admin, and update/deactivate/reset
refuse staff. The two existing gating blocks were restructured: one
"createUser auth gating" (staff creating a non-company user is refused on
`field: "role"`), and the cross-action loop split into
unauthenticated-refuses-all + admin-only-refuses-staff.

## Key decisions

**"Company accounts only" (Mayuresh, from a 3-option prompt).** The
alternatives — *"only users they personally invited"* (needs an `invitedBy`
column + migration, and staff couldn't cover for each other) and *"assigned
companies"* (a whole staff↔company assignment feature + migration + UI) —
both cost a schema change for marginal product gain. "Company accounts
only" needs zero migration and matches how staff already manage **all**
client companies. Internal admin/staff accounts are simply out of staff's
view.

**Staff can resend invites, but not reset passwords (Mayuresh).** The clean
line: staff own the **onboarding** lifecycle (create + resend invite) but
not the **management** lifecycle (update / deactivate / reset password).
Safe because `resendInvite` only ever acts on not-yet-activated accounts —
it can't touch a live one. Resolves the failed-invite-email edge without
handing staff a credential-reset capability the matrix denies them.

**Route stays `/dashboard/admin/users`.** Relocating to `/dashboard/users`
would churn every internal link, the sidebar, the detail/edit/new routes,
and the just-shipped docs for a cosmetic gain. "admin" reads as
"administration"; middleware never gated `/admin/*` to admin-role anyway
(it's auth-only — role checks are per-page).

**The decision supersedes the doc (Mayuresh chose "update the doc").** The
RBAC matrix previously granted staff *all* users; this narrows it. Rather
than leave the matrix stale, `08-rbac-matrix.md § Users` was updated to the
implemented behavior — code + this matrix now agree.

**Three-layer enforcement.** Page gate (redirect company-role users) →
action gate (`requireAdminOrStaff` + per-action company scoping) → UI hiding
(nav, filters, edit, action panel). The edit route + `updateUser` keep
`requireAdmin`, so the UI hiding is never the only barrier.

## Gotchas surfaced

**"Companies they manage" had no schema meaning.** Staff carry no
`companyId`, and no staff↔company table exists — confirmed by reading the
full table list in `lib/db/schema.ts` and the companies module's
`resolveReadScope` (which hands admin **and** staff `scopeCompanyId: null`,
i.e. "see everything"). So the matrix phrase couldn't be implemented
literally; it became "all client companies", and the constraint that
actually bites is **role** (company-only), not company-set.

**This module is now stricter for staff than the companies module.** Staff
see *all* companies but only *company-role* users. That asymmetry is
intentional for v1 but is a flag: the broader staff model across companies /
documents / tenders still grants full scope, and should be reconciled in one
deliberate pass (see followups).

**The preview harness still can't drive a react-hook-form submit** (the
Day-33 limitation). `preview_fill` + `preview_click` set DOM values but
RHF's submit didn't fire, so login bounced back to `/login`. Worked around
it by driving the inputs through the **native value setter + dispatched
input/change/blur events**, then `form.requestSubmit()` — that fired RHF's
handler and the login went through. This unblocked a real cross-role
browser walkthrough (the Day-33 report couldn't drive interactive submits at
all).

**`preview_screenshot` timed out twice** (renderer hiccup on the long
table). Accessibility snapshots — the preferred text-verification path —
carried the whole verification instead.

## Surfaces touched

Part B (`be7605b`), working tree on `dev`:

```
lib/users/actions.ts                                           (modified — staff gates + company scoping)
lib/users/__tests__/actions.test.ts                            (modified — staff-path suite + restructured gating)
components/dashboard/sidebar.tsx                                (modified — adminOnly → roles allowlist)
components/users/user-form.tsx                                 (modified — viewerRole, role locked to Company for staff)
app/dashboard/admin/users/page.tsx                            (modified — list gate admin+staff, hide role filter)
app/dashboard/admin/users/_components/filters-bar.tsx         (modified — showRoleFilter)
app/dashboard/admin/users/_components/users-table.tsx         (modified — hide Edit for staff)
app/dashboard/admin/users/_components/users-table-section.tsx (modified — thread viewerRole)
app/dashboard/admin/users/[id]/page.tsx                       (modified — detail gate + viewerRole/canEdit)
app/dashboard/admin/users/[id]/_components/user-header.tsx    (modified — canEdit)
app/dashboard/admin/users/[id]/_components/user-actions.tsx   (modified — role-aware panel, resend-only for staff)
app/dashboard/admin/users/new/page.tsx                        (modified — invite gate + viewerRole)
docs/08-rbac-matrix.md                                         (modified — staff Users rows 🟡, note rewritten)
docs/06-api-reference.md                                       (modified — two access tiers + per-action gates)
docs/reports/day-34-report.md                                 (NEW — this file)
```

14 modified in `be7605b` (+487 / −185); this report added separately. No
migration. No new deps.

## Test totals

Before Day 34 on `dev`: **773 passing, 0 skipped across 41 files** (Day-33
addendum end). After Day 34: **778 passing, 0 skipped across 41 files**.

Net +5 in `lib/users/__tests__/actions.test.ts`: a 9-case staff-path suite
added; the cross-action gating loop dropped its now-incorrect "staff
refused" assertions for the four staff-open actions (−4 effective). `pnpm
exec tsc --noEmit` clean.

## Verification

**tsc clean; 778 passing.** Then a full **cross-role browser smoke test** on
the local dev server (seeded DB), driving login per-role via the
native-setter workaround:

- **Staff** (`staff@consultway.local`): list scoped to company users only
  (0 admin/staff rows); role filter hidden; no Edit; invite form role-locked
  to "Company" (disabled + helper copy); pending company detail → Resend
  invite only; activated company detail → no actions panel. **Resend invite
  driven end-to-end** → toast "Invite resent", zero console errors.
- **Admin** (`admin@consultway.local`): regression check — list shows all
  three roles; role filter present; Edit actions present. Full experience
  intact after the shared-component changes.
- **Company** (`acme@example.local`): no "Users" nav item; direct hit on
  `/dashboard/admin/users` redirects to `/dashboard`.

The one path not browser-checkable — staff → internal-user detail returning
not-found — is covered by the unit test (a staff session genuinely can't
obtain an internal user's id, which is the proof). `next build` not run; the
dev server compiled + rendered every modified route cleanly.

## Live URL + data state

`dev` is now at `be7605b`; the push triggered CI + Deploy Staging.

- **URL**: https://consultway-ops-staging.mayuresh-dongare.workers.dev
- Once deployed, staff sign-ins reach `/dashboard/admin/users` with the
  company-scoped view.
- Invite/reset **emails** remain log-fallback on staging until the Resend
  secret + `NEXT_PUBLIC_APP_URL` are set (followups below) — the feature
  itself deploys regardless.

## Followups for Day 35+

**From this session:**

1. **Reconcile the broader staff model.** The Users module now scopes staff
   to company accounts, but companies / documents / tenders still grant
   staff full scope. Decide whether the "staff = client-facing only" idea
   should extend across modules, and update `08-rbac-matrix.md` + the
   actions to match in one deliberate pass.
2. **Resend go-live** — verify the sender domain + `wrangler secret put
   RESEND_API_KEY --env staging` (and prod). **Mayuresh's DNS + secret
   time.**
3. **`NEXT_PUBLIC_APP_URL` for invite links** — repoint to a reachable
   origin or stand up the custom domain (touches `wrangler.jsonc` — needs an
   explicit OK).

**Carried forward (unchanged):**

4. Staff-create UX nicety: if `invitedBy` tracking is ever wanted (so a
   staff list could optionally show "invited by me"), that's the `invitedBy`
   column + migration deferred this session.
5. The long tail — PDF reports spike (Day-31 #5), Cmd+K palette (Day-26 #6),
   email-change flow (Day-27 #2), organizations table (Day-26 #4), 2FA
   (Day-25 #4), active-sessions list (Day-25 #5), cron handler wiring
   (Day-30 #4), bundle-size CI step (Day-30 #7), doc-rewrite sweep
   (Day-30 #6).

## Carry-forward to Day 35

- **The Users module is committed + pushed** — `dev` at `be7605b`, working
  tree clean. No uncommitted work.
- **Staff scope = company accounts only.** `requireAdminOrStaff` gates the
  four staff-open actions (list/read/create/resend); each scopes to
  `role = "company"`. Management lifecycle (update/deactivate/reset) stays
  `requireAdmin`. `08-rbac-matrix.md § Users` is the source of truth and
  matches the code.
- **No per-staff company assignment exists.** If that's ever wanted, it's a
  new table + migration + assignment UI — a real feature, not a tweak.
- **Sidebar nav gating is now a `roles` allowlist** (`components/dashboard/
  sidebar.tsx`) — add `roles: [...]` to any future role-restricted item.
- **CLAUDE.md hard rules still hold** on `wrangler.jsonc` /
  `next.config.ts` / `package.json` deps. Followups #2/#3 need an OK.
