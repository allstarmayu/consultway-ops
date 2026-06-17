# Day 35 — landing in-app notifications + invite-only tenders

_Date: 2026-06-17_

## Scope

Two features, two commits, both shipped:

1. **Land the in-app notifications feature.** The notification feed + its
   programmatic write side had been sitting in-flight on the `dev` working
   tree (built but uncommitted, unreported). This session finished the event
   wiring across all the domain sites, pruned a dead notification kind,
   verified, and committed + pushed it to `dev`.
2. **Build invite-only tenders** (a per-tender audience model). This came out
   of a client requirement Mayuresh surfaced — *"published tenders should be
   seen by selected companies only, not every company"* — which turned out
   **not** to be implemented at the visibility layer at all (the codebase
   showed every published tender to every company; eligibility only gated
   *applying*, a deliberate Phase-1 "show all + badges" choice). A 3-option
   prompt resolved the model to a **hand-picked invite list** (vs an
   eligibility-based filter), with the invite list **replacing** eligibility
   on invited tenders, as a **per-tender** toggle (open ⇆ invited).

End-of-day state: `dev` at `c68a504` (notifications, pushed → staging deploy);
`feat/invited-tenders` at `4013b5f` (invited tenders, pushed, PR-ready against
`dev`). tsc + eslint clean; **808 passing across 43 files**; `next build`
green; migration 0018 applied locally; create-form browser-verified.

## What shipped

### Part A — In-app notifications (`c68a504`, 31 files, on `dev`)

A per-user notification feed (the bell):

- **Schema + migration 0017** — a `notifications` table (recipient-keyed,
  `read_at` NULL == unread) with `(user_id, read_at)` and
  `(user_id, created_at)` indexes.
- **Write side (`lib/notifications/notify.ts`)** — `createNotification` /
  `createNotificationsForUsers`, fail-soft (never throws; logs on error),
  mirroring `recordAuditEvent`. Called by domain actions at the same site
  they email / audit.
- **Read side (`lib/notifications/actions.ts`)** — `listNotifications`,
  `unreadNotificationCount` (backs the badge, degrades to 0 on query error),
  `markNotificationRead`, `markAllNotificationsRead`. Every action scoped to
  `user_id = session.userId` in the WHERE — no admin/staff override.
- **UI** — `/dashboard/notifications` (feed + all/unread filter + pagination,
  mirroring the companies/users list shells), per-row mark-read on activate,
  "Mark all read", and a sidebar **bell + unread badge** (fetched once in the
  dashboard layout, shared by desktop + mobile).
- **Event wiring** — six sites raise notifications: company compliance change
  → the company's users; company self-registration → active admins; tender
  application decision → the applicant's users; tender awarded → the awarded
  company's users; tender published → eligible compliant companies; document
  expiring (cron) → the company's users, sharing the email's `reminders_sent`
  dedup.
- **Pruned `user_invited`** — an invited user can't sign in to see an in-app
  entry until they accept, by which point it's stale; the invite email carries
  that touch. Every declared `NotificationType` now maps to exactly one event.

### Part B — Invite-only tenders (`4013b5f`, 21 files, on `feat/invited-tenders`)

- **Schema + migration 0018 (additive)** — `tenders.visibility`
  (`open` | `invited`, default `open`) + a `tender_invited_companies`
  junction table (mirrors `tender_applications`: composite-unique on
  `(tender_id, company_id)` + reverse-lookup indexes). Existing tenders stay
  `open` — nothing disappears.
- **Domain (`lib/tenders/{schemas,state-machine,actions}.ts`)**
  - `createTender` / `updateTender` persist `visibility`, reconcile the invite
    list via `syncInvitedCompanies` (deduped, existence-checked, publisher
    excluded), and **null the eligibility filters** on invited tenders (the
    allowlist replaces them). `visibility` + the invite list are **draft-only**
    — frozen at publish via the editable-fields rule.
  - `listTenders` / `getTender` — a company sees an invited, non-draft tender
    only if it's the publisher or on the allowlist; otherwise "not found"
    (no existence leak). Implemented as a SQL audience predicate
    (`visibility='open' OR publisher OR id IN invited-set`).
  - `applyToTender` — invited tenders gated **solely** by the allowlist
    (eligibility bypassed; the eligibility guards are additionally
    `open`-guarded for defence in depth).
  - `publishTender` — refuses an invited tender with **zero invitees**.
  - `tender_published` notification — retargeted: invited tenders notify
    exactly the invited companies' users; open tenders keep the
    eligibility-matched fan-out.
  - `listTenderInvitedCompanies` — admin/staff read action for the management
    UI.
- **UI**
  - Tender form: an **Audience** section with an invite-only toggle + a new
    searchable **company multi-select** (`components/tenders/company-multi-select.tsx`),
    built on the existing checkbox primitive (no combobox in the kit). The
    eligibility section **hides** when invite-only is on.
  - Detail page: an **Audience card** — managers see the invited roster as
    chips; an invited company sees a "you've been invited" note.
  - `new` / `edit` pages feed the selectable-companies list; the edit page
    prefills the current invite list.

## Key decisions

**The client requirement was never implemented as visibility.** Reading
`listTenders` + `08-rbac-matrix.md` + `03-development-phases.md:607` showed the
Phase-1 build deliberately chose *"companies see all published tenders, with
'not eligible' badges"* — the alternative the phases doc explicitly allowed.
So "selected companies only" was a genuine gap, not a regression. Surfaced
this honestly rather than claiming it was "still there."

**Hand-picked allowlist, not eligibility-based visibility (Mayuresh, 3-option
prompt).** The alternative — gating visibility on the existing
sector/geography/MSME/turnover filters — was rejected in favour of a true
private-tender allowlist.

**Invite list replaces eligibility on invited tenders (Mayuresh).** On an
invited tender the eligibility filters are nulled at write time and bypassed at
apply time — the allowlist is the sole gate. Enforced at both the write layer
(null the columns) and the read layer (the apply gate is `open`-guarded).

**Per-tender toggle, not blanket (Mayuresh).** A tender is either `open`
(unchanged) or `invited`. Backward-compatible; preserves the public-tender
flow. Existing tenders default to `open`.

**Audience frozen at publish.** `visibility` + the invite list join the
eligibility filters in the publish-locked set — changing a live tender's
audience would move the goalposts on companies that already applied or were
invited. Force a fresh draft instead.

**Notifications module is own-user-only.** No admin/staff override on the bell
feed (RBAC § Notifications) — ownership is enforced in the WHERE clause, never
just the UI.

## Gotchas surfaced

**The `eligibility=eligible` list filter in `06-api-reference.md` doesn't
exist.** The doc claimed a server-side filter that was never built; eligibility
is surfaced as UI badges, not a query param. Corrected the doc (code wins).

**The preview harness still can't drive react-hook-form submit / Radix
controlled toggles on the first try.** The notifications + tender forms both
hit this (Days 33–34 limitation). Worked around it for the audience toggle via
dispatched `pointerdown`/`pointerup`/`click` events after a clean navigation —
that flipped the controlled Switch and confirmed the conditional render
(eligibility hides, multi-select appears, selection updates the count). Full
create→publish submit not driven in-browser; covered by the domain unit tests.
`preview_screenshot` timed out (renderer hiccup, as on Day 34) — the eval +
accessibility checks carried the verification.

**`tenderInvitedCompanies` join uses a surrogate `id` PK + unique index**, not
a composite PK — `primaryKey` isn't imported anywhere in the schema and every
table follows the `id` convention. Mirrored `tender_applications` exactly.

**JSX indentation when wrapping the eligibility `<FormSection>` in a
conditional** took a couple of passes — no auto-formatter in the repo (only
`eslint`, which doesn't enforce JSX indent). Settled on keeping the section at
the file's standard 6-space indent inside the `{!isInvited && ( … )}` wrapper.

## Surfaces touched

**Part A** — `c68a504` (31 files): `lib/notifications/*` (types, schemas,
notify, actions, 2 test files), `app/dashboard/notifications/*` (page +
loading/error + 5 `_components`), `lib/db/schema.ts` + migration 0017,
`lib/{companies,tenders,auth}/actions.ts` + `lib/documents/crons/expiry-sweep.ts`
(event wiring), the sidebar/mobile-sidebar/layout (bell + badge), `scripts/seed.ts`,
`docs/{05,06}`, and the wiring tests.

**Part B** — `4013b5f` (21 files): `lib/db/schema.ts` + migration 0018,
`lib/tenders/{schemas,state-machine,actions}.ts`,
`components/tenders/{tender-form,company-multi-select}.tsx`,
`app/dashboard/tenders/{new,[id],[id]/edit}/page.tsx` +
`[id]/_components/tender-audience-card.tsx`, four `lib/tenders/__tests__/*`,
and `docs/{03,05,06,08}`.

## Test totals

Before this session (Day 34 end, on `dev`): **778 passing / 41 files**.
After Part A (notifications): the module + wiring tests landed with the commit.
After Part B (invited tenders): **808 passing / 43 files** — +9 for invited
tenders (createTender links/nulls, publish-needs-invitees, publish-notifies-
only-invited; apply non-invited-refused + invited-bypasses-eligibility; list/
detail visibility shown/hidden/publisher/admin/status-filter). `tsc --noEmit`
clean; `eslint` clean; `next build` green.

## Verification

- **Notifications:** tsc + tests green at commit; module is own-user-scoped
  (unit-covered).
- **Invite-only tenders:** tsc clean ✓ · eslint clean ✓ · 808 tests ✓ ·
  `next build` green (all tender routes compiled) ✓. Migration 0018 applied to
  the local DB. Browser smoke on the create form: open state renders Audience +
  eligibility; invite-only toggle hides eligibility and shows the multi-select
  (search + 31 selectable companies + count); selecting updates the footer; no
  console errors.
- **Not browser-driven:** the full create→publish→cross-role-visibility flow
  (RHF submit + multi-page) — the documented preview limitation; the
  security-critical gates are fully unit-tested.

## Live URL + data state

- `dev` at `c68a504` — pushed; CI + Deploy Staging triggered (notifications +
  migration 0017 land on staging).
- `feat/invited-tenders` at `4013b5f` — pushed; **PR not yet opened** (`gh` CLI
  not installed locally). Create via
  `https://github.com/allstarmayu/consultway-ops/pull/new/feat/invited-tenders`
  with base `dev`.
- **URL:** https://consultway-ops-staging.mayuresh-dongare.workers.dev

## Followups for Day 36+

**From this session:**

1. **Open the invited-tenders PR** (base `dev`) and merge → staging gets
   migration 0018 + the feature. (`gh` not installed; web UI or install `gh`.)
2. **Manual browser walkthrough of the full invited flow** once merged:
   create invite-only tender → pick companies → publish → sign in as an invited
   vs non-invited company and confirm visibility + apply gating, and the bell.
3. **Losing-applicant notification on award** — awarding an invited (or open)
   tender still doesn't notify the other shortlisted applicants they weren't
   selected. Clean follow-up; needs a "not selected" notification kind or
   reusing `application_rejected`.
4. **Audience changes after publish** — deliberately frozen; if a real need
   arises (add an invitee to a live tender), it's a scoped unlock, not a tweak.

**Carried forward (unchanged):**

5. Reconcile the broader staff model across modules (Day 34 #1); Resend
   go-live + `NEXT_PUBLIC_APP_URL` (Day 33–34); the long tail — PDF reports
   spike, Cmd+K palette, email-change flow, organizations table, 2FA,
   active-sessions list, cron handler wiring, bundle-size CI step.

## Carry-forward to Day 36

- **Notifications is live on `dev`** (`c68a504`, pushed). The bell, the feed,
  and six event sites are wired. `createNotification` /
  `createNotificationsForUsers` (`lib/notifications/notify.ts`) is the write
  entry point for any new event — call it at the email/audit site, fail-soft.
- **Invite-only tenders is committed + pushed but UNMERGED** on
  `feat/invited-tenders`. The PR (base `dev`) is the next action.
- **`tenders.visibility`** (`open` | `invited`) is the audience switch; the
  allowlist lives in `tender_invited_companies` and **replaces** eligibility on
  invited tenders. Audience is draft-only.
- **Migration 0018 is applied locally + committed**; it lands on staging when
  the PR merges to `dev`. `db:migrate` targets `./.wrangler/consultway-local.sqlite`.
- **CLAUDE.md hard rules still hold** on `wrangler.jsonc` / `next.config.ts` /
  `package.json` deps and on migrations (0017/0018 were generated + applied
  with explicit OK).
