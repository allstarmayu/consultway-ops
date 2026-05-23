# Day 15 — Public registration, email verification, password reset

_Date: 2026-05-23_

## Scope

The first end-to-end authentication path that does not require admin
involvement. Three deliverable chunks, each its own commit on `dev`,
closing the long-standing "no public sign-up" gap and landing the two
flows it implies:

1. **Public `/register` page + `registerCompany` Server Action.** A
   prospect fills the form; we create a paired `companies` + `users`
   row in one action. User starts with `emailVerifiedAt: null` so
   Chunk 2 has somewhere to hook in.
2. **Email verification flow.** Single-use token table, hand-rolled
   email template, `/auth/verify` Server Component that consumes the
   token, login gate that refuses unverified accounts, and an
   enumeration-defended `resendVerificationEmail` action.
3. **Password reset flow.** Symmetric to Chunk 2 but with a 1-hour
   token window, a request email + confirmation email pair, and the
   `/forgot-password` and `/reset-password` pages.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` 308/308 green every run (was 272; +36 net),
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean
against the dev DB after migrations 0009 and 0010 applied.

## What shipped

### Chunk 1 — Public registration page + `registerCompany` (commit `207d9c6`)

**Schema extensions in `lib/auth/schemas.ts`:**

- `passwordPolicySchema` — ≥10 chars, must contain at least one letter
  AND one number, ≤72 chars (bcrypt's hard upper bound). Reused by the
  registration schema and Chunk 3's reset schema.
- `registerCompanySchema` — single Zod object covering both company
  fields (name, sector, geography, optional GST/PAN, contact triplet)
  and user fields (userName, userEmail, password). The userEmail field
  defaults to `contactEmail` when blank via a `superRefine` + `transform`
  pair, so the common single-email workflow doesn't force the user to
  type the same value twice. `acceptedTerms: z.literal(true)` rejects
  both `false` and missing/undefined with the same message.
- GST/PAN regex mirrors `lib/companies/schemas.ts` (duplicated, not
  imported — dep arrow points down: registration creates a company, not
  the reverse).

**`registerCompany` Server Action (`lib/auth/actions.ts`):**

The first action in the codebase that runs without an authenticated
session. Pipeline:

1. Zod parse → first failure carries a `field` hint
2. Soft duplicate-check (parallel, indexed) on userEmail, gstNumber,
   and panNumber → friendlier than the SQLite UNIQUE surface
3. Insert `companies` row with `complianceStatus: "pending"` and the
   form's contact triplet
4. Insert `users` row with `role: "company"`, the new companyId,
   `isActive: true`, `emailVerifiedAt: null`, and the bcrypt-hashed
   password
5. Best-effort rollback of the company row if the user insert fails
   (orphaned company rows are acceptable; duplicate-detection guides a
   re-attempt)
6. Late-race UNIQUE failure translates back to the same field hint via
   `translateRegistrationConflict`
7. Audit BOTH inserts with `actorRole: "system"` and `SYSTEM_ACTOR_ID`
   — there is no real actor before this action runs. Same convention
   the cron uses.

Returns `{ ok: true, userId, companyId }` (Chunk 2 extends with
`verificationEmailSent`).

**UI surfaces:**

- `app/register/page.tsx` — Server Component shell. Already-logged-in
  users are redirected to `/dashboard` (creating a second account
  makes no sense for an authenticated user).
- `app/register/_components/register-form.tsx` — Client Component
  using react-hook-form + the inline Zod resolver pattern (same shim
  as the login form for Zod 4 + RHF compatibility). Three
  `<FormSection>` blocks (Company / Primary contact / Your account)
  in stack layout, native HTML `<input type="checkbox">` for the
  terms field (radix's Checkbox uses `onCheckedChange` and would need
  a Controller wrapper — not worth it for one field).
- `app/register/check-email/page.tsx` — Static placeholder for
  Chunk 1; Chunk 2 fills in the real verification copy.
- Login page: gains a "Need an account? Register your company" link
  below the form.

**Tests in `lib/auth/__tests__/register.test.ts` (+14):**

- happy path: company + user inserted, BOTH audit rows written under
  the system actor
- new user starts with `emailVerifiedAt: null` AND `isActive: true`
  (the two states are deliberately distinct — verification gate is the
  active barrier, isActive reserved for staff deactivation)
- password is bcrypt-hashed not stored plaintext (`$2[aby]$` prefix)
- userEmail defaults to contactEmail when blank
- null gstNumber + null panNumber accepted
- duplicate userEmail refusal with `field: 'userEmail'`
- duplicate gstNumber refusal with `field: 'gstNumber'`
- duplicate panNumber refusal with `field: 'panNumber'`
- password <10 chars Zod refusal
- password without any letter refusal
- password without any number refusal
- missing acceptedTerms refusal
- malformed GSTIN refusal
- blank userEmail + invalid contactEmail combo refusal

Total at end of Chunk 1: **286 tests**.

### Chunk 2 — Email verification flow (commit `05068a4`)

**Schema + migration:**

- New `email_verification_tokens` table on `lib/db/schema.ts`:
  `id` (UUID v7), `userId` (FK users.id ON DELETE CASCADE),
  `tokenHash` (sha256 hex of the raw token), `expiresAt`, `createdAt`,
  `usedAt`. Unique index on `tokenHash`; index on `userId` for the
  "show me this user's outstanding tokens" pattern used by the resend
  flow and eventual cleanup.
- Migration `drizzle/0009_redundant_king_bedlam.sql` — clean CREATE
  TABLE, generator preserved the cascade clause correctly (CREATE
  TABLE works, ALTER TABLE ADD COLUMN strips it — Day 14 gotcha).
  Applied locally via `pnpm db:migrate`; no remote DB touched.

**Token mint + consume (`lib/auth/tokens.ts`):**

- `mintEmailVerificationToken(userId)` — 32 random bytes via
  `node:crypto.randomBytes`, hex-encoded (64 chars), sha256-hashed
  for storage, 24h expiry. Returns the raw token to the caller (the
  only time the raw value exists outside the inbox).
- `consumeEmailVerificationToken(rawToken)` — re-hashes, looks up by
  hash, returns a discriminated union: `{ok:true, userId}` |
  `{ok:false, reason: 'not_found' | 'expired' | 'already_used'}`.
  Never throws. On success, stamps `usedAt` and flips
  `users.emailVerifiedAt` in two sequential awaits (better-sqlite3
  doesn't expose Drizzle's `db.transaction` symmetrically for the
  test substrate; the UNIQUE index on hash prevents double-spend
  even with a parallel consume).

No constant-time compare is needed because the lookup IS the
comparison — we look up by hash. A wrong hash returns no row, not a
row with a different hash to be string-compared against.

**Email template (`lib/email/templates/email-verification.ts`):**

`renderEmailVerificationEmail({ user, verifyUrl, expiresInHours })`.
Subject: `Verify your Consultway account`. Single CTA button to the
verify URL + a fallback "paste this link" block. Footer notes "Didn't
sign up? You can safely ignore this email." Shape mirrors Day-14's
`application-shortlisted.ts` — inline-styled HTML, table layout,
hand-rolled `escapeHtml`.

**`registerCompany` wiring:**

The Day-14 DI pattern. Public `registerCompany(input)` calls
`registerCompanyInternal(input, { sendEmail })` exposed for tests. The
production action mints a token + sends the verification email after
the user is created. Fail-soft: on send failure or pipeline throw the
registration still succeeds; the result carries
`verificationEmailSent: false` so the check-email page can render a
"resend" prompt instead of pretending the mail went out.

**`/auth/verify` Server Component:**

Reads `?token=...`, calls the consume helper, branches on the four
outcomes:

- success (`ok: true`) → "Verified, sign in" + CTA to /login
- `expired` → "Link expired" + CTA to resend
- `already_used` → "Already verified" + CTA to sign in (lets the user
  proceed without a fresh round-trip — they're already verified, the
  link just happens to have been clicked twice)
- `not_found` (also covers missing/empty token) → "Link no longer
  valid" + CTA to resend

The consume helper never throws, so this page is pure server render
with no try/catch.

**`resendVerificationEmail` action:**

Enumeration-defended — always returns `{ ok: true }` regardless of
whether the email exists or is already verified. Three branches:

1. Unknown email → log at info, no insert, no send
2. Known + verified → log at info, no insert, no send (a successful
   enumeration here would tell an attacker which addresses have
   accounts; the trade-off is that an already-verified user clicking
   resend gets nothing visible — accepted because login already works
   for them)
3. Known + pending → mint new token, send

The /register/check-email page now exposes the "Resend verification
email" button (Client Component `_components/resend-button.tsx`) that
posts to this action and renders a uniform "if your account exists,
we've sent a fresh link" message on any response.

**Login gate:**

A new step 6b in `login` between password check and session creation:
if `emailVerifiedAt` is null, refuse with `field: 'email'` + error
"Verify your email first. We sent you a link when you signed up." The
login page detects this specific branch (field === 'email' AND error
matches /verify/i) and surfaces a "Resend verification email" link
inside the error Alert. Crucially, the link is NOT shown for other
login failures — that would help email enumeration. Wrong-password
attempts on an unverified account hit the password gate first and get
the generic "Invalid email or password" — verification state isn't
revealed.

**Tests in `lib/auth/__tests__/verification.test.ts` (+13):**

Token round-trip:
- mint → consume → flips `emailVerifiedAt`; raw token matches `[0-9a-f]{64}`
- second consume of same token refuses with `already_used`
- unknown token returns `not_found`
- expired token (force-rewritten `expiresAt`) refuses with `expired`

Pipeline:
- registerCompany with stub sendEmail mints exactly one token row +
  sends exactly one mail with the verification subject; URL is in
  both html and text bodies
- stub sendEmail returning ok:false → user is still created,
  `verificationEmailSent: false`
- stub sendEmail throwing → user is still created,
  `verificationEmailSent: false`

Resend:
- unknown email returns ok WITHOUT sending or inserting
- already-verified email returns ok WITHOUT sending or inserting
- known + pending mints + sends; the user now has ≥2 tokens

Login gate:
- unverified user refused with `field: 'email'` + verify copy
- after consume, login redirects (mocked next/navigation throws a
  sentinel `NEXT_REDIRECT` error tests `.rejects.toThrow`)
- wrong password on unverified user returns the generic invalid-creds
  error — no leak of verification state

Total at end of Chunk 2: **299 tests**.

### Chunk 3 — Password reset flow (commit `3abf6d0`)

**Schema + migration:**

New `password_reset_tokens` table, column-for-column identical to
`email_verification_tokens`. Lives in its own table (not a shared
`auth_tokens` with a discriminator) because the two flows differ in
expiry, downstream effect, and audit categorisation — a shared table
would obscure all three differences. Migration
`drizzle/0010_calm_blacklash.sql`, clean CREATE TABLE, applied
locally.

**Token helpers extended in `lib/auth/tokens.ts`:**

- `mintPasswordResetToken(userId)` — same shape as verification mint
  but with a **1-hour** TTL (shorter — stolen reset links are a
  higher-stakes outcome than stolen verification links).
- `consumePasswordResetToken(rawToken, newPasswordHash)` — atomic
  pipeline:
  1. Look up by hash
  2. Refuse not-found / already-used / expired (discriminated)
  3. Stamp the matching token used
  4. Write the new password hash on `users`
  5. **Invalidate every OTHER unused reset token for the same user**

The sibling-invalidation step is defence in depth: if a user requested
two resets and the first link was intercepted, consuming the second
voids the first. Cost is a single indexed UPDATE; benefit is the
window in which an intercepted link stays exploitable closes the
moment a legitimate reset completes. Sibling rows are marked used
(not deleted) so the forensic history stays inspectable.

Caller hashes the new password BEFORE calling — keeps tokens.ts free
of bcrypt knowledge and lets the action layer apply the project's
password pepper via `lib/auth/password::hashPassword`.

**Two new email templates:**

- `password-reset-request.ts` — subject "Reset your Consultway
  password". CTA button to `/reset-password?token=...`. Footer:
  "Didn't request this? Ignore this email — your password is
  unchanged." The reassurance matters because users who didn't
  request the reset will see this email and need to know clicking
  ignore is safe.
- `password-reset-confirmation.ts` — subject "Your Consultway
  password was changed". **No CTA button** — purely informational.
  Body includes an amber-bordered alarm block: "If this wasn't you,
  contact ops@consultway.local immediately. Your account may be
  compromised." Confirmation-on-change is a standard security
  pattern; a compromised account that just had its password rotated
  is the one case where you WANT to alarm the legitimate owner.

Both follow the same hand-rolled inline-style + table-layout pattern.
Inline `escapeHtml` duplicated across templates (now five copies —
might be worth hoisting to a shared helper if a sixth lands, but
five-copy duplication isn't yet justifying the abstraction cost).

**`requestPasswordReset` action:**

Enumeration-defended — always returns ok. Unknown email → no mint, no
send, log at info. Known email → mint a 1h-expiry token + send the
request email. Send-failure is fail-soft (logged at warn, doesn't
change the response shape). The DI pattern matches Chunk 2.

**`resetPassword` action:**

Pipeline:
1. Zod-validate input (token shape + new password against
   `passwordPolicySchema`)
2. Hash the new password via `lib/auth/password::hashPassword`
   (pepper-aware)
3. Call `consumePasswordResetToken(token, newHash)` — this is the
   atomic step
4. On any non-ok consume result, return the right friendly error +
   `field: 'token'` (the token isn't user-editable, so the page
   surfaces it as a banner, not a field-level error)
5. Send the confirmation email (fail-soft)
6. Return `{ ok: true }`

**Session-invalidation: documented gap.** Sessions are stateless JWTs
today (`lib/auth/session.ts`), so a reset does NOT revoke outstanding
tokens. A stolen JWT issued before the reset stays valid until its
natural 7-day expiry. The right fix is a `passwordChangedAt`
timestamp on `users` and a check in `proxy.ts` that refuses JWTs
issued earlier than that timestamp. Logged as a warn line at the
action layer (so the gap is visible in any incident timeline) and
captured as Phase-3 followup #1 below. Not added to the schema in
this session because the proxy-side check is the load-bearing half
and it needs its own design pass.

**UI surfaces:**

- `app/forgot-password/page.tsx` + Client form. Single email input.
  On submit shows "If an account exists for that email, we've sent a
  reset link" — same copy regardless of the action's outcome, no
  conditional branch on existence.
- `app/reset-password/page.tsx` + Client form. Reads `?token=...`
  from search params, forwards as a hidden input, renders a "new
  password" field. On success redirects to `/login?reset=success`.
- Login page: "Forgot password?" link inline with the password label
  (right-aligned, small). When `?reset=success` is in the URL the
  page shows an inline success notice ("Password updated. Sign in
  with the new one.") instead of wiring a global toast — cheaper for
  one event.

**Tests in `lib/auth/__tests__/password-reset.test.ts` (+9):**

Token round-trip:
- mint → consume → flips password hash + stamps `usedAt`
- siblings: minting 3 tokens then consuming the SECOND one marks all
  3 used; the first/third now refuse with `already_used`
- expired token refusal
- unknown token returns `not_found`

requestPasswordReset:
- unknown email returns ok WITHOUT sending or inserting
- known email mints + sends with the right subject

resetPassword:
- weak new-password Zod refusal lands `field: 'newPassword'`
- end-to-end: request → fresh mint → reset → confirmation email goes
  out AND `verifyPassword(newPassword, hash)` returns true while
  `verifyPassword(oldPassword, hash)` returns false (the password
  actually changed)
- friendly errors for not_found and already_used branches with
  `field: 'token'`

Total at end of Chunk 3: **308 tests**.

## Key decisions

**Three chunks, each its own migration, each its own commit.** Could
have landed Chunks 2 and 3 as a single "verification + reset" PR with
one combined migration. Resisted because the verification migration
(0009) is needed for Chunk 2's tests to even run, and forcing the
reset surface to wait on that would couple two unrelated audit
trails. Two thin migrations beat one thicker one when the dep arrow
is asymmetric.

**Single-page registration form, not multi-step.** The Day-5 plan
brief sketched a multi-step wizard (Identity → Compliance → Documents
→ Contact). Held off — the multi-step UX is its own design pass and
single-page is what every other unauthenticated form on the platform
looks like (login, forgot-password, reset-password). Adding a wizard
in this session would have stretched scope without closing the
"prospects can't self-register" gap any faster. Captured as
followup #2.

**Verification gate sits AFTER the password gate, not before.**
Order matters for enumeration safety. If `if (!user.emailVerifiedAt)`
fired before `verifyPassword`, an attacker could enumerate which
emails have unverified accounts by submitting any password and
observing "verify your email first" vs "invalid email or password".
Putting the password gate first means wrong-password attempts on
unverified accounts get the same generic refusal as wrong-password
attempts on verified ones — the user's verification state is only
revealed to someone who already knows their password.

**Resend-verification button only shows on the field=email branch.**
The login page's Alert has a "Resend verification email" link, but
only when the failure was specifically the verification gate. Showing
it on every "invalid creds" failure would create an enumeration
oracle: every email an attacker types could be probed for "is this
even an account?" by clicking resend and observing what happens. The
field hint is the contract — the prose ("Verify your email first")
is the human-facing channel, the field discriminant is the
machine-facing one.

**Always-ok return for resend + request-reset.** Both actions return
`{ ok: true }` regardless of whether the email exists. This is the
standard enumeration-defence pattern; the corresponding UX cost is
that a user who typos their email gets no feedback that nothing was
sent. The trade-off favours defence: a small UX confusion (which the
"If an account exists for that email..." copy explicitly names) beats
an enumeration oracle.

**Hash tokens at rest, never store raw.** Same principle as bcrypt
for passwords: a DB leak should not yield still-valid links. Stored
sha256 hex is enough — we look up by hash, so the hash IS the
comparison; no constant-time compare needed. The raw token only ever
exists in `mint*Token`'s return value and in the user's inbox.

**Sibling-invalidation on password reset, not on email verification.**
Verification can be requested multiple times without security cost —
each fresh mint just extends the spendable set. Password reset can't
— a stolen reset link is exploitable until consume time, and a user
who requested two resets has two simultaneously-valid links in the
wild. Consuming one invalidates the rest. Asymmetric handling that
reflects asymmetric risk.

**Separate tables for the two token kinds.** A single `auth_tokens`
table with a `kind` discriminator (`'verification' | 'reset'`) would
have been one fewer migration. Rejected because the two have
different TTL conventions (24h vs 1h), different downstream effects
(`emailVerifiedAt` flip vs `passwordHash` write), and different audit
categorisation (registration verb vs security-event verb).
Discriminator-driven dispatch in the consume helpers would obscure
all three differences and create a footgun where adding a third
token kind tomorrow (e.g. magic-login links) would force every
existing consumer to handle three branches.

**No transaction wrapper on consume.** Both consume helpers do two
sequential awaits (stamp used + apply effect). better-sqlite3 via
Drizzle does support transactions but the test substrate (in-memory
`:memory:` DB per worker) doesn't share the connection with the same
ergonomics. The risk of a half-applied consume is bounded: the
UNIQUE index on tokenHash prevents double-spend, and a crash between
the two updates leaves an "already-used" token row with a still-old
user state — recoverable via a fresh request. If real-world abuse
ever shows up here, wrapping is a one-line change.

**Confirmation email has NO CTA.** Standard pattern. A user who just
changed their password doesn't need a button. A user who DIDN'T
change their password needs to be alarmed and pointed at an alarm
channel (support email, not a self-service "lock my account" button —
that doesn't exist yet, and a button that does nothing would be
worse than no button at all).

**1-hour reset TTL vs 24h verification TTL.** Reset is higher-stakes
— a token in the wild can change the password and lock the legitimate
user out. Verification can only set a single flag. The shorter window
reduces the time-of-exposure for the more dangerous artifact.

**Session-invalidation gap explicitly documented, not stubbed.**
Could have added a `passwordChangedAt` column today and a check in
the proxy. Both halves are load-bearing; the proxy check needs its
own design pass (does it gate ALL routes? what about the verification
endpoint itself?) and the column needs a backfill story. Cleaner to
ship the action with a warn-level log naming the gap than to
half-implement the revocation surface. Captured as followup #1 with
the full plan.

## Gotchas surfaced

**radix Checkbox doesn't bind cleanly with react-hook-form's
`register()`.** The radix primitive uses `onCheckedChange` instead of
`onChange`, so `{...register("acceptedTerms")}` produces a checkbox
that visually toggles but never updates the form state. Caught when
the first test run failed the `acceptedTerms: false` refusal case —
the field was stuck at the default and never reached the schema.
Swapped to a native `<input type="checkbox">` (one field, doesn't
justify a Controller wrapper). Worth noting for future form work that
includes radix-primitive form controls.

**`@/lib/auth/session` mock needed to cover `createSession` +
`destroySession` even when login() is the only call under test.** The
test runner resolves the whole module at import time, so any
non-mocked export that's referenced anywhere in the import chain
(actions.ts imports both) needs a stub. Initial verification.test.ts
mock only mocked `readSession` and failed at module-load with
"createSession is not a function." Fixed by stubbing all three.

**next/navigation `redirect` test sentinel.** The login action calls
`redirect(destination)` on success and Next.js signals redirects by
throwing a special value. To assert "login succeeded and would
redirect" without pulling Next's test plumbing in, I mocked
`next/navigation` to throw a sentinel error with `__redirectTo`
attached, then asserted `.rejects.toThrow(/NEXT_REDIRECT/)`. Same
pattern any future "did this action redirect" test should follow.

**Mock-test fresh-mint side-channel.** The end-to-end "request →
reset → password changed" test couldn't capture the raw token from
inside the stub sendEmail (the action embeds the raw token in the
HTML body, but pulling it out by regex would be brittle). Worked
around by minting a SECOND token directly via the helper inside the
test and using that for the consume step. The action-level send is
covered by a separate test that asserts the mail goes out with the
right subject; the round-trip test exercises consume + verify
behaviour without depending on the URL-extraction substring. Worth
remembering for future flow tests.

**Soft duplicate-check race window.** `registerCompany` checks for
duplicate userEmail/gst/pan before insert (friendlier errors), then
proceeds. Two parallel registrations with the same userEmail will
both pass the soft check then race on the DB UNIQUE constraint. The
loser falls through `translateRegistrationConflict` and gets the same
field hint as the soft-check branch would have produced. Tested via
the duplicate-refusal cases — the soft check is what runs in the
happy-path-second-attempt case. The UNIQUE-constraint fallback is the
load-bearing safety net.

**Migrations 0009 and 0010 both CREATE TABLE.** Both came out of
drizzle-kit clean — the FK cascade clause was preserved (CREATE TABLE
works correctly, ALTER TABLE ADD COLUMN is the broken case from Day
14). No hand-edits this session. If a future migration adds a column
to either of these tables with a FK, expect to hand-edit the
generator's output.

**RESEND_API_KEY still empty locally → both new email kinds route
through the log-fallback path.** Same behaviour as Day-10/14 emails
— `lib/email/client` writes a stub-log line and returns ok. Lets the
register + reset flows be tested end-to-end via the dev DB without
any external email service. The `verificationEmailSent: boolean` on
the register result is true in this case (the stub IS a success),
which is correct: the action's contract is "did the send-pipeline
complete ok," not "did Resend confirm delivery."

## Surfaces touched

```
# Chunk 1 — Public registration page + action (commit 207d9c6)
app/login/page.tsx                                                  (modified - "Register your company" link below the form)
app/register/_components/register-form.tsx                          (new)
app/register/check-email/page.tsx                                   (new - placeholder; Chunk 2 fleshes out)
app/register/page.tsx                                               (new)
lib/auth/__tests__/register.test.ts                                 (new - 14 tests)
lib/auth/actions.ts                                                 (modified - registerCompany + helpers)
lib/auth/schemas.ts                                                 (modified - passwordPolicySchema, registerCompanySchema + the resend/reset schemas added together for Chunks 2+3)

# Chunk 2 — Email verification flow (commit 05068a4)
app/auth/verify/page.tsx                                            (new - four-outcome render)
app/login/page.tsx                                                  (modified - unverified-account branch + resend link)
app/register/check-email/_components/resend-button.tsx              (new)
app/register/check-email/page.tsx                                   (modified - real copy + resend wired)
drizzle/0009_redundant_king_bedlam.sql                              (new - email_verification_tokens table)
drizzle/meta/0009_snapshot.json                                     (new - drizzle-kit generated)
drizzle/meta/_journal.json                                          (modified - drizzle-kit generated)
lib/auth/__tests__/verification.test.ts                             (new - 13 tests)
lib/auth/actions.ts                                                 (modified - login gate, registerCompanyInternal DI, resendVerificationEmail)
lib/auth/tokens.ts                                                  (new - mint/consume helpers; password-reset half added in Chunk 3)
lib/db/schema.ts                                                    (modified - email_verification_tokens table)
lib/email/templates/email-verification.ts                           (new)

# Chunk 3 — Password reset flow (commit 3abf6d0)
app/forgot-password/_components/forgot-password-form.tsx            (new)
app/forgot-password/page.tsx                                        (new)
app/login/page.tsx                                                  (modified - Forgot link + reset-success notice)
app/reset-password/_components/reset-password-form.tsx              (new)
app/reset-password/page.tsx                                         (new)
drizzle/0010_calm_blacklash.sql                                     (new - password_reset_tokens table)
drizzle/meta/0010_snapshot.json                                     (new - drizzle-kit generated)
drizzle/meta/_journal.json                                          (modified - drizzle-kit generated)
lib/auth/__tests__/password-reset.test.ts                           (new - 9 tests)
lib/auth/actions.ts                                                 (modified - requestPasswordReset, resetPassword)
lib/auth/tokens.ts                                                  (modified - mint/consume password-reset half)
lib/db/schema.ts                                                    (modified - password_reset_tokens table)
lib/email/templates/password-reset-confirmation.ts                  (new)
lib/email/templates/password-reset-request.ts                       (new)

# Day 15 report (this commit)
docs/reports/day-15-report.md                                       (new)
```

## Test totals

Before this session: **272 tests across 11 files**, all green (Day
14 end state).

After this session: **308 tests across 14 files**, all green every
run. Net: **+36**.

Breakdown of the delta:

- +14: `register.test.ts` (Chunk 1 — new file)
- +13: `verification.test.ts` (Chunk 2 — new file)
- +9: `password-reset.test.ts` (Chunk 3 — new file)

The brief budgeted ~35–50 new tests; landed at +36, comfortably
inside. No existing test files needed editing — the verification
gate test in `verification.test.ts` covered the login-action behaviour
change end-to-end via the same `registerCompanyInternal` substrate.

## Followups for Day 16+

**From this session:**

1. **Session invalidation on password reset.** The right fix:
   `passwordChangedAt` timestamp column on `users` + a check in
   `proxy.ts` that refuses JWTs whose `iat` is earlier than the
   user's `passwordChangedAt`. Today the reset action logs a warn
   line naming the gap. Phase-3 hardening; not load-bearing for the
   common case where the user owns their email and inbox.
2. **Multi-step registration UX.** The Day-5 plan spec sketched a
   four-step wizard (Identity → Compliance → Documents → Contact).
   Single-page form shipped this session covers the must-have; the
   wizard is an own-design-pass UX deliverable.
3. **CAPTCHA / rate limiting on the unauthenticated surfaces.**
   `/register`, `/forgot-password`, and the `?token=` consume
   endpoints are public; a determined attacker could brute-force
   email enumeration via timing analysis or attempt token-guessing
   (cheap given the search space is 2^256 but worth a rate limiter
   anyway). Phase-3 hardening.
4. **Public tender browsing for unauthenticated visitors.** Today
   tender visibility is gated on a logged-in role check; opening the
   surface for un-signed-in visitors is a separate design pass
   (which fields are public, which are paywalled, how does it
   interact with the "Need an account" CTA).
5. **Token cleanup cron.** Both new token tables grow append-only.
   A cron that purges rows older than 30 days (used or expired)
   keeps the table small. Same shape as the expiry-sweep cron;
   trivial to land.
6. **Hoist `escapeHtml` to a shared helper.** Now five copies across
   the templates directory. The next template tilts the balance —
   if a sixth lands, hoist before adding it.

**Deployment wiring (carry-forward, still gated on dep install):**

7. **`@opennextjs/cloudflare` install + `open-next.config.ts`.** Same
   as Day 13/14 — the scheduled handler module exists, the re-export
   step lands when the dep gets installed.
8. **D1-backed Drizzle client factory.** Same shape as Day 13/14
   followup.
9. **Resend domain verification + production secret.** Procedure
   lives in `docs/09-deployment.md` § 3.5.
10. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
    Still `REPLACE_WITH_*` placeholders.

**Cleanup / nice-to-have (carry-forward):**

11. **Side-sheet vs side-by-side detail view at desktop widths.**
    Carry-forward.
12. **Seed self-healing on changed fixtures.** Carry-forward.
13. **Stage real fixtures into R2** for demo download paths.
    Carry-forward.
14. **`__drizzle_migrations` tracker note in contributing doc.**
    Carry-forward.
15. **drizzle-kit ALTER TABLE ADD COLUMN cascade-clause gotcha**
    (Day 14 followup). Did NOT surface this session — both
    migrations used CREATE TABLE — but the underlying generator bug
    is still there for the next ALTER TABLE migration that adds a
    FK column.
16. **`docs/05-database-schema.md` rebaseline.** Day 14 noted the
    tenders table is broadly out of sync; Day 15 added two new
    tables (`email_verification_tokens`, `password_reset_tokens`)
    that the doc doesn't list at all. A dedicated doc-pass session
    closes the gap.

**Already-resolved this session:**

- Long-standing "no public sign-up" gap — closed end-to-end. A
  prospect can now register, verify their email, and sign in
  without admin involvement.
- Long-standing "no password recovery" gap — closed. Users can
  request a reset link and choose a new password without staff
  intervention.

## Carry-forward to Day 16

- **`dev` ended at 4 commits past Day 14's final state** (Day 14's
  report commit was `4b2eb6f`; this session's commits are
  `207d9c6` / `05068a4` / `3abf6d0` plus this report's commit).
  Run `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing still requires explicit approval per `<permissions>`.
- **308 tests passing on every run.** Three new test files added;
  no existing files needed editing; no flakes observed across the
  session's runs.
- **Migrations 0009 and 0010 applied to dev DB.** Both new tables
  (`email_verification_tokens`, `password_reset_tokens`) present.
  `pnpm db:reset` would rebuild from scratch correctly via the
  migrations chain. The Day-12 drift class did not surface this
  session.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` from the Day-12 dedup row. Expected;
  not a regression.
- **`pnpm cron:pending-cleanup`** clean (`deletedCount=0`).
- **`RESEND_API_KEY` still empty** in `.env.local` — both new email
  kinds route through log-fallback. Production wiring is the
  deployment session's task.
- **`PASSWORD_PEPPER=dev-only-pepper-replace-in-prod`** still in
  `.env.local`. Do NOT change without re-seeding.
- **Login flow now has three reachable error branches**: invalid
  creds (`field: 'form'`), deactivated (`field: 'form'`), and
  unverified email (`field: 'email'`). UI surfaces a resend link
  only for the third — the field hint is the discriminant, not the
  prose.
- **`registerCompany` is the codebase's first auth-less Server
  Action.** Any future "public action" (e.g. public tender search)
  can use it as the precedent — pattern is Zod-validate, soft-check
  for friendlier errors, audit under `SYSTEM_ACTOR_ID` + role
  "system".
- **Session-invalidation gap on password reset is documented**, not
  closed. A reset succeeds, the password changes, the confirmation
  email goes out, but outstanding JWTs stay valid until natural
  expiry. Followup #1 above has the plan.

That's Day 15.
