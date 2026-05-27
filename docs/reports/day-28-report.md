# Day 28 — quick-wins bundle: auth-page parity, server.ts tests, phone + jobTitle persistence

_Date: 2026-05-27_

## Scope

Normal pick-from-the-queue day. Day-27 closed three Day-26 followups
plus an SSR-density defect; today closed three Day-27 followups
(phone, server.ts tests, theme picker on forgot/reset) plus an
opportunistic bonus (jobTitle, sharing the same migration as phone).

Phase 0 surfaced an off-by-one in the Day-27 report: `378dcbb` was
described as "sitting on dev that I haven't pushed," but `git fetch`
showed it already at `origin/dev`. The Day-27 push must have happened
right before the report was committed and the report didn't get
updated. Noted, no action — purely a documentation drift.

Phase 1 triage picked **A + B combined** from the Day-27 carry-forward
matrix. Browser verification of the picker-on-flat-bg framing
surfaced a small deviation: /forgot-password and /reset-password
don't actually have the gradient backdrop /login + /register use,
so "drop in the picker" wouldn't bring the four into visual parity.
Recommended adding the gradient at the same time (~5 extra min, same
files); approved.

Four ordered phases across 13 files. Type-check clean after every
phase, scoped tests green after the implementation, full suite green
at end, production build clean, and a live browser smoke test on the
running dev server signing in as `admin@consultway.local`, exercising
the save flow, doing a hard reload, doing a clear-to-null cycle, and
inspecting the resulting `users` row + audit log via `better-sqlite3`.

End-of-day verification: `pnpm exec tsc --noEmit` silent after every
phase; `pnpm test --run lib/preferences lib/profile` **29/29 green**
(11 existing preferences + 9 existing profile + 3 new server + 6 new
profile); `pnpm test --run` (full suite) **665/665 across 36 files**;
`pnpm build` clean (26/26 pages); live browser smoke confirmed the
save flow end-to-end including SSR persistence after F5 and scoped
audit snapshots in the DB.

One new migration (0015 — `users.phone` + `users.job_title`, both
TEXT NULL, no defaults). No new dependencies. One commit (`1fdcb48`),
pushed clean: `378dcbb..1fdcb48 dev -> dev`.

## What shipped

### Phase 1 — Gradient + picker on /forgot-password + /reset-password

Day-27 followup #5. The framing in the Day-27 prompt said the gradient
backdrop was already there and the picker just needed dropping in.
Browser check showed otherwise: /forgot-password + /reset-password
were on flat `bg-muted`, while /login + /register had the radial
gradient via an inline `style={{ background: "radial-gradient(...)" }}`.
Adding only the picker would have landed it floating on a flat
background while its siblings glowed underneath — broken parity.

**Fix.** Both pages adopted the same shape /login uses:

```jsx
<main
  className="relative flex min-h-screen items-center justify-center px-6 py-12"
  style={{
    background:
      "radial-gradient(ellipse at 50% 0%, color-mix(in oklab, var(--accent) 10%, var(--background)) 0%, var(--background) 60%)",
  }}
>
  <ThemePickerDropdown />
  ...
</main>
```

The `relative` class is what allows the picker's `absolute top-4 right-4`
positioning to anchor to the page edge. The gradient tracks every
palette via `--accent` and `--background` — terracotta glow on Warm
Ambient, cyan glow on Ocean Depth, etc. All four unauthenticated entry
points now behave like siblings (verified by side-by-side screenshots).

The forgot/reset forms don't inherit /login's `animate-fade-up` wrap
— deliberate scope cut, the picker + gradient was the explicit ask.

### Phase 2 — Unit tests for lib/preferences/server.ts

Day-27 followup #4. `getPreferencesForSSR` was exercised end-to-end
by the Day-27 browser walkthrough but didn't have a unit test. Three
cases cover the contract:

- **Happy path** — seed a non-default preferences row directly (no
  Server Action surface needed; the SSR-leaf reader's contract is
  "read whatever's in the column, don't synthesise"). Confirm every
  field round-trips.
- **Missing row** — no `userPreferences` row exists for the seeded
  user; the function must return the hard-coded defaults shape, not
  null or an empty object.
- **DB-error fallback** — force a one-shot throw at the SELECT call
  via `vi.spyOn(db, "select").mockImplementationOnce(() => { throw … })`,
  then confirm the function returned the defaults shape without
  propagating the error. `vi.restoreAllMocks()` in `afterEach` keeps
  the spy local to that single test.

Test file: `lib/preferences/__tests__/server.test.ts`. 3/3 green on
first run. The pattern reuses the actions.test.ts fixture shape but
without the `vi.mock` on `readSession` (the SSR reader deliberately
doesn't touch the session — that's the caller's job).

### Phase 3 — Migration 0015: users.phone + users.job_title

Day-27 followup #1 (phone) and the jobTitle bonus tied to it. Both
columns are TEXT NULL with no defaults — `phone` because it isn't an
authentication factor today (no E.164 normalisation, no verification
state) and `jobTitle` because it's purely cosmetic display data.

The migration generated cleanly into `drizzle/0015_oval_bushwacker.sql`:

```sql
ALTER TABLE `users` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `job_title` text;
```

**`pnpm db:push` failed mid-session with a TTY error.** drizzle-kit
push requires `process.stdin.isTTY` to render its confirmation prompt
— the harness shell is non-interactive, so the push hung on input.
Fix: switched to `pnpm db:migrate` (which reads the SQL file
non-interactively and applies it without prompting). Worth knowing
for future sessions: `db:push` won't work from automation contexts,
`db:migrate` will. Verified post-migration via `PRAGMA table_info(users)`
that both columns landed as TEXT, NOT NULL=0, no default — exactly
the generated SQL.

### Phase 4 — Profile schema + action + UI wiring

The `updateProfile` Server Action grew from "writes one field with a
no-op short-circuit" to "writes any subset of three fields with a
SCOPED audit diff." The scoping is the load-bearing improvement.

**Schema** (`lib/profile/schemas.ts`):

```ts
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    phone: z.union([z.string().trim().max(32), z.null()]).optional(),
    jobTitle: z.union([z.string().trim().max(120), z.null()]).optional(),
  })
  .strict();
```

The `union([z.string(), z.null()])` shape on phone + jobTitle lets the
client either send null explicitly (to clear) or omit the key (leave
alone) or send a string (set). Empty strings get coerced to null at
the action layer, so the form's "user cleared the input" gesture
round-trips cleanly. `.strict()` still rejects unknown keys at runtime
— the Day-27 sneak-key test was updated to use `email` (genuinely
out-of-scope this round) since `phone` is now valid.

**Action** (`lib/profile/actions.ts`). The new shape computes a
per-field diff up front:

```ts
const changes: {
  name?: { before: string; after: string };
  phone?: { before: string | null; after: string | null };
  jobTitle?: { before: string | null; after: string | null };
} = {};

if (existing.name !== patch.name) {
  changes.name = { before: existing.name, after: patch.name };
}
if (existing.phone !== nextPhone) {
  changes.phone = { before: existing.phone, after: nextPhone };
}
if (existing.jobTitle !== nextJobTitle) {
  changes.jobTitle = { before: existing.jobTitle, after: nextJobTitle };
}

if (Object.keys(changes).length === 0) {
  // No-op short-circuit — caller's form state still advances, but
  // no DB write and no audit row.
  return { ok: true, name: existing.name, phone: existing.phone, jobTitle: existing.jobTitle };
}
```

The diff drives both the SET payload (only changed columns get
written) AND the audit before/after (only changed columns appear in
the snapshot). Saving with the same shape three times in a row
emits zero audit rows. Saving with only `jobTitle` changed emits one
row whose `before` and `after` carry only `jobTitle` — `name` and
`phone` aren't in the snapshot because they didn't move.

This matters because the audit log is forensic — a reviewer asking
"who changed this user's job title in the last 7 days?" should see
one match per real change, not noise from save buttons being clicked
on already-correct forms. The Day-27 single-field implementation
already had this for `name`; today's change generalises it.

**Tests** (`lib/profile/__tests__/actions.test.ts`). 6 new cases on
top of the 9 from Day-27:

```
✓ persists phone and jobTitle when provided
✓ clears phone + jobTitle to null when passed null
✓ coerces an empty-string phone to null
✓ short-circuits when all three fields match the persisted shape
✓ scopes the audit snapshot to only the columns that changed
✓ rejects a phone longer than 32 chars with field: 'phone'
```

The "scoped snapshot" test is the load-bearing one — it seeds a
non-trivial three-field shape, then changes ONLY phone, and asserts
the audit row's `before` / `after` contain `{ phone: ... }` and
nothing else. Mirror of the live smoke test I ran later on the dev
server (which produced identical scoped output in the real audit log).

**UI wiring** (3 files):

- `app/dashboard/settings/page.tsx` now reads `users.phone` and
  `users.jobTitle` alongside `name` in the same indexed SELECT.
- `app/dashboard/settings/_components/settings-shell.tsx` accepts +
  forwards both new initial values.
- `app/dashboard/settings/_components/profile-section.tsx` is the
  biggest rewrite. The form's `isDirty` now lights up on ANY of the
  three persisted fields changing (email stays cosmetic). The save
  handler trims + null-coerces at the call site (defence in depth —
  the action also coerces) and advances the baseline to the persisted
  shape returned by the action so the save bar collapses cleanly.

Module docstring on `actions.ts` was rewritten — phone + jobTitle no
longer appear in the "deferred" list; only email remains there.

## Smoke test (post-commit, post-push)

After the commit landed and was pushed, ran a full live browser
smoke on the running dev server:

1. Sign in as `admin@consultway.local` / `ChangeMe123!` → /dashboard.
2. Navigate to /dashboard/settings. Confirm phone + jobTitle inputs
   are empty (NULL in the column — migration added them with no
   defaults, no backfill).
3. Type `+91 98765 43210` + `Lead Engineer`. Sticky save bar appears.
4. Click Save. Toast: "Profile updated / Your changes have been saved."
   Save bar collapses.
5. Hard reload (F5). Both inputs still carry the saved values —
   proves the SSR read in `settings/page.tsx` returns the new columns
   and the shell forwards them correctly.
6. Clear both inputs to empty string, Save. Same success flow.
7. Hard reload. Both inputs empty again.
8. Direct SQL via `better-sqlite3`:
   - `users.phone = NULL`, `users.job_title = NULL` after the clear
     (empty-string-to-null coercion works at both the action layer
     and the DB).
   - Two new audit rows for the admin actor, both with `targetType
     = 'user'` and `action = 'updated'`. Snapshots are perfectly
     scoped: only `phone` and `jobTitle` appear; `name` is absent
     from both `before` and `after` because it didn't change.
   - Day-27's older name-change audit rows are still there and
     untouched — backwards-compat preserved.

Nothing surprising surfaced. The work matches the unit-test contracts
in production.

## Key decisions

**Combined migration for phone + jobTitle.** Could have done two
separate migrations (one per field) to keep changes atomic, but both
fields land on the same table with the same shape (TEXT NULL, no
default) at the same audience (Profile section) — splitting them
would have meant two `db:generate` cycles, two `db:migrate` runs,
two reviewer-facing diffs to read, all for what's a single logical
"Profile fields now persist" beat. The migration approval gate (per
CLAUDE.md) was used once instead of twice.

**Used `db:migrate` instead of `db:push`.** Drizzle's interactive
push flow needs a TTY for its confirmation prompt; the harness shell
isn't interactive, so the push hangs on input and times out. The
generated migration file is identical either way — `db:migrate`
reads it from `drizzle/` and applies it non-interactively. The cost
is one extra file (`0015_oval_bushwacker.sql`) in the repo, which is
fine — that's the auditable schema delta anyway. Worth remembering
for any future migration session: `db:push` from a TTY is fine for
interactive dev, but automation contexts should use `db:migrate`.

**Per-field diff at the action layer, not the DB layer.** Could have
naively written all three columns on every save (the DB layer would
no-op identical writes anyway) and audited the whole user row. Chose
to compute the diff in TypeScript so the audit log carries exactly
the columns that changed — same forensic-quality argument that drove
Day-27's name-only audit shape. The cost is ~15 LOC of compare-and-
collect that I'd have skipped if the no-op short-circuit didn't
already need the comparison.

**Empty string → null at both layers (action AND form).** The schema
allows empty strings (they pass `.trim().max(32)`), but the column
shape is "string or null." Coercing at the form means the action
sees `null` in the request body when the user cleared the input.
Coercing again at the action is belt-and-suspenders — protects
against any future caller (a CLI? a test?) that sends `""` and
expects it to clear. Two layers of defence at a cost of ~6 LOC.

**Gradient on forgot/reset added in scope, not deferred.** Could
have shipped just the picker on the flat background and added the
gradient in a later "auth pages polish sweep." Decided against —
the picker positions absolute-top-right, on a flat background that
already has the form centered, the picker looks like a stray UI
element instead of part of the page. The gradient costs ~5 LOC per
page and immediately makes the picker feel intentional. Browser
verification confirmed the result is indistinguishable from /login
in palette tracking + first-paint feel.

**Smoke test as a code-driven flow, not a screenshot-only flow.**
The preview tool's `eval` lets us drive forms programmatically and
read the resulting DOM state, which is genuinely more verification
than a screenshot. The screenshot in this report shows the empty
state; the actual save flow was verified by reading the toast region
contents and checking the post-reload field values. The DB-level
inspection (better-sqlite3 PRAGMA + audit-log query) added a layer
the UI can't show.

## Gotchas surfaced

**`drizzle-kit push` requires a TTY.** As noted above — the
confirmation prompt rendering blocks on stdin. `db:migrate` is the
non-interactive substitute and reads from the generated SQL file.
For future sessions: when running migrations from automation,
always prefer `db:migrate` over `db:push`.

**The Day-27 report was stale on the "haven't pushed" claim.** The
Phase 0 push step turned out to be a no-op because `378dcbb` was
already at `origin/dev`. The Day-27 report described the push as
pending in the Carry-forward section, but it must have happened
right before the report was committed. Document drift, not a real
problem — but worth checking `git fetch && git rev-list
--count origin/dev..HEAD` at the start of every session rather than
trusting the previous report's claim.

**The "sneak unknown key" test depended on `phone` being unknown.**
Day-27's test sent `phone: "+91 99999 99999"` as the unknown-key
case because phone wasn't in the schema. After today's extension,
phone IS in the schema, so the test would have passed instead of
proving the strict-key behaviour. Updated to use `email` instead
(the only profile field still legitimately out-of-scope this round
— security-critical, needs a verify-old + verify-new flow). Worth
remembering for future schema extensions: any sneak-key tests will
need updating in tandem.

**React controlled-input boundary with nullable persistence.** The
Profile section reads `initialPhone: string | null` from props and
needs to feed it into `<Input value=...>`, which requires a string.
Coercing `initialPhone ?? ""` at the boundary keeps React from
flipping the input between controlled and uncontrolled. The action
returns the persisted null on a clear, so the baseline-advancement
step has to coerce the same way (`result.phone ?? ""`). Three
boundary coercions all going the same direction — would be cleaner
as a single helper if a fourth nullable field ever joins.

**Audit-log `before` / `after` shape is `Record<string, unknown>`.**
Building the snapshots from the diff requires the slightly awkward
`const before: Record<string, unknown> = {}; for (const [field,
diff] of Object.entries(changes)) before[field] = diff.before;`
loop, instead of a clean object literal. Could have typed
`AuditSnapshot` more tightly to make this cleaner, but the snapshot
shape is intentionally open — any action can put any keys in there.
The loop pattern stays.

## Surfaces touched

```
# Phase 1 — Auth-page sibling parity
app/forgot-password/page.tsx                                       (modified — gradient + picker mount)
app/reset-password/page.tsx                                        (modified — gradient + picker mount)

# Phase 2 — Server.ts unit tests
lib/preferences/__tests__/server.test.ts                           (new — 3 tests)

# Phase 3 — Migration
lib/db/schema.ts                                                   (modified — users.phone + users.jobTitle)
drizzle/0015_oval_bushwacker.sql                                   (new — generated)
drizzle/meta/0015_snapshot.json                                    (new — generated)
drizzle/meta/_journal.json                                         (modified — generated)

# Phase 4 — Profile persistence
lib/profile/schemas.ts                                             (modified — extend with phone + jobTitle)
lib/profile/actions.ts                                             (modified — scoped diff + audit, all 3 fields)
lib/profile/__tests__/actions.test.ts                              (modified — +6 tests, update sneak-key)
app/dashboard/settings/page.tsx                                    (modified — read phone + jobTitle)
app/dashboard/settings/_components/settings-shell.tsx              (modified — forward both)
app/dashboard/settings/_components/profile-section.tsx             (modified — wire both inputs through save)

# Day 28 report
docs/reports/day-28-report.md                                      (new — this commit, follow-up landing after the feature commit)
```

3 new files + 10 modified = **13 unique surfaces touched**, matching
the plan exactly. The report itself is the 14th (this file), landing
in a separate small commit after the feature work.

## Test totals

Before Day 28: **656 tests across 35 files** (Day 27 end state).
After Day 28: **665 tests across 36 files** — +9 tests, +1 file.

The 9 new tests:

- 3 in `lib/preferences/__tests__/server.test.ts` (new file):
  ```
  ✓ returns hard-coded defaults when no row exists yet
  ✓ returns the persisted row when one exists
  ✓ returns defaults when the DB read throws (never propagates the error)
  ```

- 6 in `lib/profile/__tests__/actions.test.ts` (extended file):
  ```
  ✓ persists phone and jobTitle when provided
  ✓ clears phone + jobTitle to null when passed null
  ✓ coerces an empty-string phone to null
  ✓ short-circuits when all three fields match the persisted shape
  ✓ scopes the audit snapshot to only the columns that changed
  ✓ rejects a phone longer than 32 chars with field: 'phone'
  ```

The 9 existing profile tests stayed green after the sneak-key
update (now uses `email` instead of `phone`). The 11 preferences
tests untouched. Net green delta: +9, zero regressions across the
full 665-test sweep.

`pnpm build` clean throughout — three runs across the day's
checkpoints, all green at 26/26 pages.

## Followups for Day 29+

**From this session:**

1. **Doc sync sweep.** `docs/05-database-schema.md` and
   `docs/06-api-reference.md` don't mention `users.phone` /
   `users.job_title` / the new `updateProfile` signature. Code is the
   source of truth per CLAUDE.md, but the docs drifting silently is a
   future-onboarding hazard. ~20 min to refresh both files.

2. **Avatar uploads via R2 (Day-26 #5).** Still on the queue. With
   phone + jobTitle landing today, the "Change photo" toast is the
   only "coming soon" sticker left on the Profile section — natural
   next polish target. ~2-3 hr including the R2 presigned-upload
   pattern, the `avatar_key` migration, and the Avatar fallback swap
   to next/image when a key is set.

3. **Email-change flow (Day-27 #2).** Still deferred. Profile's last
   non-persisting field. Security-critical (verify-old + verify-new
   with email tokens), best as a dedicated session — probably
   piggy-backed with 2FA enrolment for a focused "Security section is
   now real" sprint.

4. **Drizzle `db:push` -> `db:migrate` substitution.** Worth a one-
   line addition to `docs/10-local-setup.md` explaining the
   non-interactive path. Optional.

**Carried forward from earlier days (unchanged):**

5. Command palette / Cmd+K (Day-26 #6). Half-day on its own. Needs
   the `cmdk` dep approval.

6. Organizations table + Org section persistence (Day-26 #4 /
   Day-25 #2). Half-day, schema migration.

7. Quick-filter chips on list pages (Day-26 #9). ~1-2 hr per list
   page; demand-driven.

8. Inline edit on detail pages (Day-26 #8). Half-day per entity,
   app-wide UX shift.

9. 2FA enrolment (Day-25 #4). Whole module.

10. Real "active sessions" list (Day-25 #5). Needs a `sessions`
    table — we're stateless JWT today.

11. Resend email on compliance state change (Day-23 #3).

12. Public registration UX / CAPTCHA / rate limiting (Day-15).

13. Real Consultway logo on the PDF cover.

14. Real R2 fixture files (Day-21 #3).

15. Realistic Indian-flavoured fixture data (Day-21 #2).

16. Searchable typeahead selects on forms + reports pickers.

17. Compliance state-transition history widget (Day-23 #2).

18. Bulk-transition action for admins (Day-23 #5).

19. Per-document CSV export / Bulk CSV import / Saved-report-config
    persistence / deleteProject / Project-attached documents /
    Side-by-side detail view / TransactionType badge palette
    unification / session invalidation on password reset / public
    tender browsing / OpenNext install / D1 client factory / Resend
    domain verification / Real Cloudflare bucket UUIDs / Hoist
    escapeHtml.

## Multi-session roadmap (per Day-28 end-of-session check-in)

The end-of-session conversation laid out a sequence for closing the
remaining queue across multiple sessions, accepted as Path A (wrap
Day 28 first, fresh chat per session afterward):

```
D29  doc sync sweep + avatars via R2          (migration: avatar_key)
D30  Cmd+K command palette                    (new dep: cmdk)
D31  email-change flow                        (migration: maybe email_change_tokens)
D32  organizations table + Org section        (migration: organizations + FK)
D33  quick-filter chips across 4 list pages   (no migration, no dep)
D34  inline-edit pilot on one entity          (no migration, no dep)
D35  sessions table + 2FA enrolment           (migration + new dep: otpauth)
```

Total: ~25-30 hours, conservatively 7-8 sessions over 1-2 weeks.
Per-session approval gates apply for each migration and each new
dependency — see CLAUDE.md `<permissions>`.

## Carry-forward to Day 29

- **Day-28 feature commit landed and pushed:** `1fdcb48` on
  `origin/dev`. 13 files, +2378/-86 (the larger insert count is the
  auto-generated `drizzle/meta/0015_snapshot.json` containing the
  full schema snapshot — normal Drizzle output).
- **This report committed separately,** following Day-27's convention
  of one feature commit + one docs commit.
- **Three Day-27 followups closed:** #1 (phone), #4 (server.ts unit
  tests), #5 (theme picker on /forgot-password + /reset-password).
  Plus the jobTitle bonus (not on the Day-27 list — emerged as a
  natural pair with phone since both shared the same migration).
- **665 tests passing across 36 files.** +9 net, zero regressions.
- **One schema migration applied:** `0015_oval_bushwacker.sql`.
- **No new dependencies.** Three new files (1 new test file, 2 new
  drizzle artefacts) plus this report.
- **`db:migrate` is the migration command for automation contexts.**
  `db:push` requires a TTY that the harness can't provide. Worth
  remembering — every future migration session should reach for
  `db:migrate` first.
- **Profile section now persists three of four fields.** Email is
  the lone holdout, deliberately deferred until a security-themed
  session can land the verify-old + verify-new flow alongside 2FA
  enrolment.
- **D29 starts fresh.** Doc sync sweep first (~20 min) as a cheap
  warmup, then avatars-via-R2 as the main beat. New conversation
  for context-budget reasons.

That's Day 28.
