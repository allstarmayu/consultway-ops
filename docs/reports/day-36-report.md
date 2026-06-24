# Day 36 — losing-applicant notification on award + dev→main promotion

_Date: 2026-06-24_

## Scope

A short, focused session resuming from Day 35:

1. **Build the losing-applicant notification on award** (Day-35 followup #3).
   Awarding a tender notified only the winner; the other live applicants got
   nothing and were left waiting on a decision. This wires an
   `application_not_selected` notification into `markAwarded` for every active
   non-winning applicant.
2. **Promote `dev` → `main`.** On request, the entire app (130 commits — every
   feature since Day 3, all 18 migrations) was fast-forwarded onto `main`, which
   had been sitting at the early brand-tokens scaffolding. This is the first
   time `main` has carried the real app.

End-of-day state: `dev`, `main`, and `origin/main` all at `136b3a9`. tsc +
eslint clean; scoped tender suite **49 passing** (+4); notifications suite **13
passing**; no migration, no new deps. **No production deploy run** — promoting
to `main` does not auto-deploy (there is no prod workflow; `deploy:prod` is
manual).

## What shipped

### Losing-applicant notification (`136b3a9`, 5 files, on `dev` + `main`)

A new notification kind so non-winning bidders learn a tender went elsewhere:

- **New `NotificationType`** — `application_not_selected`
  (`lib/notifications/types.ts`), added to the closed union + doc. No DB
  migration: the `type` column is plain text validated app-side.
- **`markAwarded` fan-out (`lib/tenders/actions.ts`)** — after the winner's
  `application_awarded` notification, query every **active** non-winning
  applicant (`status IN ('submitted','shortlisted')`, `companyId != winner`)
  and fan `application_not_selected` out to those companies' users. Fail-soft,
  raised at the same site as the winner notification (after the status flip +
  audit succeed). Withdrawn applicants (opted out) and already-rejected ones
  (told at rejection time) are excluded by the status filter.
- **Feed icon** — `CircleSlash` for the new kind in `notification-item.tsx`
  (the icon map is string-keyed with a `Bell` fallback, so it never crashes on
  an unmapped type).
- **Docs** — `06-api-reference.md § Notifications` event-sources table gains the
  `application_not_selected` row (raised by `markAwarded`, recipients =
  the other live applicants' users).
- **Tests** — +4 in `state-machine.test.ts`: a shortlisted runner-up is
  notified; a still-`submitted` (never-shortlisted) applicant is notified; a
  `withdrawn` applicant is **not**; an already-`rejected` applicant is **not**.

### dev → main promotion

- `git push origin dev` — `bbe6d26..136b3a9` (this commit; triggers CI + the
  staging deploy).
- `git push origin dev:main` — `6c275c2..136b3a9`, a clean **fast-forward**
  (`main` was a strict ancestor of `dev`; no force-push, no history rewrite).
  Local `main` synced to match. CI runs on `main`; **no auto prod-deploy**.

## Key decisions

**New dedicated kind, not reused `application_rejected`.** "Lost to another
bidder" reads differently from a merit rejection, and the cost is ~zero — the
notification `type` is app-validated text, so a new kind needs no migration. The
Day-35 report had left this open ("a 'not selected' kind or reusing
`application_rejected`").

**No application-status mutation — notify only.** The losers' application rows
are left untouched. Auto-rejecting them on award would fight `retractAward`
(which moves the tender back to `closed`): it would strand `rejected` rows that
staff would then have to reinstate. Notify-only keeps the reversal path clean.

**In-app only, no email.** Matches `markAwarded`'s existing winner notification,
which has never sent email. Keeps the change small and avoids threading the
email dependency into the award path.

**Active applicants only.** Both `submitted` and `shortlisted` non-winners are
notified — anyone with a live bid deserves to know the tender closed against
them, not just the shortlisted finalists.

**Promote the whole `dev` line to `main` (Mayuresh, explicit request).** "Push
to main" has only one mechanical reading here: because `main` is a strict
ancestor of `dev`, pushing this commit necessarily brings its 130 ancestors —
there is no one-commit push. Surfaced that implication (full promotion to the
prod branch; no auto-deploy) before proceeding.

## Gotchas surfaced

**`main` was 130 commits behind `dev`.** Every feature since Day 3 lived only on
`dev` (which auto-deploys to staging); `main` still held the Day-0/1 brand-token
scaffolding (`6c275c2`). The daily workflow has been `dev`→staging, with `main`
untouched — so "push to main" was a milestone-level promotion, not a routine
push. Flagged it clearly; the push itself was a clean fast-forward.

**No production deploy workflow exists.** `ci.yml` runs on push to `main` and
`dev`; `deploy-staging.yml` triggers only on `dev`. There is no `main`→prod
deploy job, so landing on `main` runs CI but ships nothing to production — prod
is the manual `pnpm deploy:prod` (which applies all 18 migrations to prod D1 +
deploys the Worker). Worth keeping in mind before the first real prod cutover.

## Surfaces touched

`136b3a9` (5 files, +153 / −1):

```
lib/notifications/types.ts                                      (modified — application_not_selected kind + doc)
lib/tenders/actions.ts                                          (modified — markAwarded loser fan-out)
app/dashboard/notifications/_components/notification-item.tsx   (modified — CircleSlash icon)
lib/tenders/__tests__/state-machine.test.ts                     (modified — +4 award-notification tests)
docs/06-api-reference.md                                        (modified — notifications event-sources row)
```

This report (`day-36-report.md`) added separately. No migration. No new deps.

## Test totals

Day 35 end: **808 passing / 43 files**. This session added **+4** to
`lib/tenders/__tests__/state-machine.test.ts` (that file now **49 passing**) →
expected **812 / 43**. The full suite was **not** re-run (scoped per the
verification rules); the scoped tender suite (49) and notifications suite (13)
both ran green. `tsc --noEmit` clean; `eslint` clean on the touched files.

## Verification

- **tsc clean ✓ · eslint clean (touched files) ✓ · tender state-machine suite
  49 passing ✓ · notifications suite 13 passing ✓.**
- **Not browser-driven:** the new `CircleSlash` feed icon. It's a string-keyed
  map entry with a `Bell` fallback (can't crash), and the notification only
  fires on a multi-step award flow the preview harness can't drive (the
  documented Days 33–35 RHF limitation). The security/correctness-critical
  fan-out is fully unit-covered.
- `next build` not run — no route or RSC-shape change.

## Live URL + data state

- `dev` at `136b3a9` — pushed; CI + Deploy Staging triggered (no new migration,
  so a worker redeploy only).
- `main` at `136b3a9` — promoted (full app on the prod branch); CI runs, **no
  prod deploy**.
- **Staging URL:** https://consultway-ops-staging.mayuresh-dongare.workers.dev
- Production: not yet deployed. First cutover is `pnpm deploy:prod` — applies
  migrations 0001–0018 to prod D1 + deploys the Worker. Needs an explicit go.

## Followups for Day 37+

**From this session:**

1. **First production deploy (when ready).** `main` now carries the app, but
   nothing is live in prod. `pnpm deploy:prod` is the manual cutover — it runs
   all 18 migrations against prod D1 and deploys the Worker. Treat as a
   deliberate release (secrets, `NEXT_PUBLIC_APP_URL`, smoke test) — see the
   carried-forward Resend / app-URL items below.
2. **Audience-after-publish unlock** (Day-35 #4) — adding an invitee to a live
   invited tender is still deliberately frozen at publish; a scoped state-machine
   unlock if a real need arises.

**Carried forward (unchanged):**

3. Reconcile the broader staff model across modules (Day-34 #1); Resend go-live
   + `wrangler secret put RESEND_API_KEY` (Mayuresh's DNS + secret time);
   `NEXT_PUBLIC_APP_URL` for invite links (touches `wrangler.jsonc` — needs an
   OK).
4. The long tail — PDF reports spike (`spike/pdf-react-worker` branch), Cmd+K
   palette, email-change flow, organizations table, 2FA, active-sessions list,
   cron handler wiring, bundle-size CI step.

## Carry-forward to Day 37

- **`main` == `dev` == `136b3a9`.** `main` is no longer stale — it now mirrors
  `dev`. The daily flow is still `dev`→staging; decide whether future work keeps
  promoting to `main` per-change or in batches.
- **`application_not_selected`** is the seventh tender/application notification
  kind, raised by `markAwarded` alongside `application_awarded`. Losers are
  notified, but their application status is intentionally left unchanged.
- **`createNotificationsForUsers`** (`lib/notifications/notify.ts`) remains the
  fail-soft write entry point for any new event — call it at the email/audit
  site.
- **No production deploy has run.** `deploy:prod` is manual and applies 18
  migrations to prod D1 — a deliberate, explicit-OK action.
- **CLAUDE.md hard rules still hold** on `wrangler.jsonc` / `next.config.ts` /
  `package.json` deps, migrations, and anything touching prod.
