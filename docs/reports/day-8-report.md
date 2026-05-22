# Consultway Ops - Day 8 Report

**Date:** May 22, 2026
**Author:** Mayur (with Claude as engineering partner)
**Branch:** `dev`
**Commits:** 3 new commits on top of Day 7's foundation

---

## Executive summary

Day 8 closed a four-day-old debt. The turnover-eligibility gate on
`applyToTender` - stubbed with a TODO since Day 4, called out in every
report from Day 4 onward - is now real. A company has a stated annual
turnover, a tender can set a minimum, and an applying company that
doesn't meet the bar is refused at the action layer with a user-facing
error explaining why.

Three commits shipped to `dev`. Each is independently `tsc`-clean and
independently smoke-tested end-to-end against the live local DB. The
chunking matched the Day-8 prompt's suggestion almost exactly:
schema + migration, then gate logic + Zod, then form + display. No
surprises, no scope creep, no late-stage refactors.

The shape of the gate ended up with two distinct refusal branches that
weren't called out in the original prompt - "tender requires a minimum
but the company hasn't stated theirs" gets a different error and a
different field hint than "company has stated their figure but it's
below the bar". Both refusals were exercised end-to-end in the smoke
test; both render cleanly.

A small bit of incidental tech debt was paid down while the iron was
hot: the inline `formatInr` helper that has lived inside
`components/tenders/tender-form.tsx` since Day 4 is now a shared
module at `lib/format/inr.ts` with two exports (`formatInr` with the
rupee glyph for UI, `formatInrAscii` with the `Rs.` prefix for logs
and error messages). The tender form's visual output is byte-identical
to before. The new company form and detail page consume the same
helper.

---

## What works today

### The turnover-eligibility gate

- `companies.annual_turnover` is a nullable INTEGER column (cid 20)
  on the `companies` table. Same shape as
  `tenders.min_annual_turnover_inr` so the two compare cleanly without
  coercion gymnastics. Migration `0005_zippy_reavers.sql` was a single
  `ALTER TABLE` and applied cleanly via `pnpm db:push`.
- The gate sits in `applyToTender` between the MSME check (step 6)
  and the soft-duplicate check (step 7). Two refusal branches:
    - **Unstated turnover.** Tender sets a minimum, company's
      `annualTurnover` is NULL: refuse with a `field: 'annualTurnover'`
      hint and the message "This tender requires a minimum annual
      turnover. Update your company's annual turnover on the company
      profile before applying." The field hint lets the form focus the
      gap on the company record itself.
    - **Stated but below bar.** Tender sets a minimum, company's
      `annualTurnover` is set but lower: refuse with the formatted
      figure - "Your stated annual turnover (Rs.1,00,00,000) does not
      meet this tender's minimum of Rs.5,00,00,000." No field hint
      here, deliberately - the user cannot unilaterally fix this by
      editing their own row (raising turnover just to apply would be
      fraud), so pointing the form at a field would be misleading.
- NULL on the tender side (`minAnnualTurnoverInr === null`) skips the
  gate entirely. Both stated-zero and unstated-NULL companies pass
  through unmolested when the tender has no minimum.
- Gate-rejected attempts deliberately do NOT emit audit events. Matches
  the existing convention - schema rejections, auth failures, and the
  soft-duplicate refusal are all silent on the audit log. Only
  successful state changes audit. If we ever want forensic visibility
  on repeat-rejection patterns, a dedicated
  `tender_application_rejected_eligibility` verb is the right shape;
  not pulled forward speculatively.

### Schema + Zod plumbing

- `lib/db/schema.ts` adds `annualTurnover: integer("annual_turnover")`
  on the `companies` table. The matching `tenders.minAnnualTurnoverInr`
  docstring updated to remove the "deferred" footnote that referenced
  the missing companies-side counterpart.
- `lib/companies/schemas.ts` exports a new reusable
  `annualTurnoverSchema` primitive: `z.coerce.number().int()
  .nonnegative().max(MAX_SAFE_INTEGER).optional().nullable()`. Same
  shape as the tender side's primitive. Composed into both
  `createCompanySchema` and `updateCompanySchema` so the field flows
  through create and patch paths uniformly.
- `annualTurnover` is editable by all roles in `updateCompany`,
  including `company`. Sits in the role-agnostic block alongside name
  and sector, NOT inside the staff-only block with `internalNotes` and
  `complianceStatus`. Defensible: turnover is a fact about the company
  that the company itself is the authority on; making it staff-only
  would block self-service and force a support ticket for every figure
  update.
- `deleteCompany`'s audit snapshot includes `annualTurnover` in the
  pre-deletion row capture. Forensic queries on deleted companies can
  see what figure was on record when they were removed.

### Form + detail-page surface

- New "Commercial profile" section on the company form, sitting between
  "Identifiers" (GST/PAN/MSME) and "Joint venture". Reads as a natural
  progression: who you are -> your papers -> your finances -> your
  structure. Single field today; the section title is generic enough
  to absorb future commercial fields (paid-up capital, working-capital
  line, banker reference) without renaming.
- The input mirrors the tender form's `minAnnualTurnoverInr` exactly:
  leading rupee glyph inside the input via absolute positioning,
  numeric type with `inputMode="numeric"`, empty string maps to null,
  valid input gets truncated to a whole-rupee int, NaN is rejected and
  keeps prior state rather than poisoning the form. Live en-IN echo
  below the input - "10000000 -> Rs.1,00,00,000" - so users can
  sanity-check a big number at a glance.
- Matching "Commercial profile" section on the company detail page
  (`/dashboard/companies/[id]`), single Fact with the formatted figure
  via the same shared helper.
- Empty-state copy on the detail page is "Not stated" rather than
  "Not on file" (used for GST/PAN). Deliberate distinction - turnover
  is a fact the company itself is the authority on, not paperwork
  awaiting arrival, so the empty hint puts the ball in the company's
  court instead of reading like a passive missing-document state.

### Shared INR formatter

- `lib/format/inr.ts` (new module) exports two functions:
    - `formatInr(rupees: number | null | undefined): string` - UI
      default, rupee glyph, en-IN locale grouping, accepts null and
      returns empty string. Used by the tender form, the company form,
      the tender detail overview, and the company detail overview.
    - `formatInrAscii(rupees: number): string` - `Rs.` ASCII prefix,
      requires a number (no null branch). Used by the turnover gate's
      error messages. Reason for the ASCII split: error messages get
      JSON-encoded and flow through logs that may not be UTF-8-clean;
      the rupee glyph mojibakes in some log-viewer pipelines.
- The inline `formatInr` that lived inside
  `components/tenders/tender-form.tsx` since Day 4 is gone. The tender
  form's visual output is byte-identical to before the lift (verified
  against the previous render).
- Pure module, no React, no Next-specific imports. Importable from
  "use server" files, Client Components, Server Components, and edge-
  runtime route handlers alike. Cached `Intl.NumberFormat` instance
  so the lakh/crore grouping is consistent across every call site.

---

## What's intentionally deferred

| Item | Why deferred |
| --- | --- |
| Fold `formatInrForError` in `lib/tenders/actions.ts` into `formatInrAscii` | The gate's local helper produces identical output. Now that `lib/format/inr.ts` is a pure no-React module, it's safe to import from server actions. One-line edit; not blocking; can ride on the next mutation in `actions.ts`. |
| Required vs optional turnover at registration | Picked "optional" deliberately. Required would have meant a backfill for the 10 existing seeded companies and friction on self-service registration. Optional means the gate refuses unstated companies at apply time, which is the right enforcement point - they discover the gap exactly when it would have mattered, not at registration. Reversible if the call turns out wrong; nothing else depends on the choice. |
| `tender_application_rejected_eligibility` audit verb | Deferred. Today's gate-rejected attempts emit no audit row (matches the existing convention for non-state-changing refusals). If forensic visibility on repeat-rejection patterns becomes a real need, a dedicated verb is the right shape; until then it's speculative. |
| Compliance check on turnover figures | Companies state their own turnover today. No verification step (against GST returns, MCA filings, etc.). For Phase 1 this matches how the existing flow works - companies are also the authority on their GST and PAN. Phase 1B or later. |
| Currency variants | INR only. The platform is Indian-tender-focused; no near-term need for USD/EUR. The formatter would generalise easily if needed - `Intl.NumberFormat(locale, { style: 'currency', currency })` - but YAGNI. |
| Range filter on tenders by turnover requirement | The tender list could grow a "show me tenders my company qualifies for" filter using the new column. Real value, real work. Not scoped today; the gate at apply time covers the correctness need. |
| Documents module | Still the obvious Day-9 candidate. R2 + presigned uploads + expiry reminders. 3-4 session arc on its own. |

---

## Key decisions

**Two refusal branches, not one.** The original prompt asked the
question explicitly: should "didn't state turnover" and "stated but
too low" produce the same error or different? Different was the right
call. The "didn't state" case is actionable by the company (update
your profile and try again) and gets a `field` hint to surface that
on the form. The "below bar" case is NOT actionable by the company
without inflating their stated figure (which is fraud), and so its
error names the figure to demystify the bar without inviting a fix.
The two branches share the gate's overall surface but diverge in
copy and field-hint.

**Turnover is role-agnostic on update, not staff-only.** Day 2's
companies module gates `internalNotes` and `complianceStatus` to
admin/staff. Adding `annualTurnover` to that staff-only list would
have been the conservative default and was rejected: turnover is a
fact about the company that the company is the authority on; making
it staff-only blocks self-service and routes every figure update
through a support ticket. The staff-only list stays at exactly the
fields where the staff/company information asymmetry is genuine.

**Optional, not required.** The form makes the field optional. Two
reasons: (a) every existing seeded company would have needed a
backfill if required, and the seeded turnover values would have been
fictional anyway; (b) the gate at apply time is the right enforcement
point - companies discover the gap exactly when it would have
mattered, not as a checklist item at registration. Reversible call;
nothing downstream depends on the choice.

**"Commercial profile" section, not "Financials" or "Annual
turnover".** Generic enough to absorb future commercial fields without
renaming, specific enough that today's reader knows what it's for.
"Financials" reads too accounting-flavoured for what's effectively a
one-figure eligibility marker. "Annual turnover" as a section title
reads odd when there's only one field; future fields would force a
rename.

**Section placement: between Identifiers and Joint venture.** The
original Day-8 prompt suggested "Categorisation & details" between
sector/geography and the MSME flag. Re-read of the actual form
showed there's no "Categorisation & details" section by that name -
the form's structure is Identity / Identifiers / Joint venture /
Contact / Address / Internal notes. Inserting between Identifiers and
Joint venture (and not, say, splitting Identifiers) preserves the
existing section structure and reads as a natural progression -
papers, then finances, then structure.

**Lift `formatInr` to a shared module while the surface is touched.**
The Day-8 scope opens the tender form and adds matching formatting on
the company form and detail page - so the inline `formatInr` in the
tender form was going to be referenced three new times if it stayed
inline. Lifting it to `lib/format/inr.ts` is a one-file change that
removes the duplication risk before it appears, and the new module's
`formatInrAscii` export now covers the gate's error-message
formatting cleanly. Two birds. The tender form's visual output is
byte-identical to before, so the lift is invisible to anyone not
diffing the code.

**ASCII formatter for error messages, glyph formatter for UI.** Same
rationale as the existing `formatInrForError` helper in
`lib/tenders/actions.ts`: error messages get JSON-encoded into
Server Action responses, flow through logs that may not be UTF-8-
clean, and the rupee glyph mojibakes in some log-viewer pipelines.
The `Rs.` ASCII prefix survives every pipeline we care about. Two
exports from one module keeps the contract explicit at the call site.

---

## Side discoveries

### `[id]` route segment quoting

The `app/dashboard/companies/[id]/_components/company-overview.tsx`
file lives under a directory with literal square brackets in the
name. PowerShell interprets `[id]` as a glob pattern unless the path
is passed as `-LiteralPath`, which means the standard
`Copy-Item -Path src -Destination .\app\dashboard\companies\[id]\_components\...`
silently fails to find the destination directory.

Workaround that landed: `Set-Location -LiteralPath '.\app\dashboard\companies\[id]\_components'`
first, then copy with a plain filename destination. Documented in
the chunk-3 file-drop instructions. Same workaround the Day-7 report
flagged for `[id]` paths - it bit a second time today before the
muscle memory kicked back in.

### Drizzle Studio not used; better-sqlite3 directly via temp `.cjs`

The smoke test exercised the gate end-to-end against the live local
DB without Drizzle Studio or wrangler. Pattern that worked: PowerShell
heredoc to a temp `.cjs` file, `node`, `Remove-Item`. The DB lives at
`./.wrangler/consultway-local.sqlite` (path from `drizzle.config.ts`),
not the initially-guessed `local.db`.

This pattern is now solid enough to write up as a `scripts/` helper -
the same heredoc dance shows up every time we need to peek at the DB,
and it's brittle to typos. Phase 1B candidate: a tiny `pnpm db:inspect
<table>` wrapper. Not blocking; the inline pattern works.

### Seeded company name had a trailing suffix

Seeded company was "Acme Construction Pvt Ltd" - the smoke test
first-shot used the shorter "Acme Construction" name and got
`undefined` back. Fast recovery via a listing query, but it cost a
round-trip. Worth noting that the project knowledge's "Acme
Construction" shorthand drifted from what's actually in the seed.
Documentation worth touching up at some point.

---

## Known technical debt

Carried forward from prior days.

- **Timestamp format inconsistency.** Still open. Same surface as
  Days 5-7: the format mismatch between SQLite's `datetime('now')` and
  JS's `toISOString()` is contained by the readers via the existing
  normalisation pattern.

- **`listTenders` company-role draft visibility.** Still uses a JS
  post-filter rather than a SQL OR clause. Fine at Phase 1 scale.

- **`markAwarded` doesn't capture the winning company.** Awaits the
  `awardedCompanyId` column when Phase 2 (project tracking) lands.

- **No FK on `audit_log.actor_id` or `target_id`.** Deliberate
  choice. The Day-7 resolver handles dangling pointers gracefully via
  "Deleted item" rendering.

- **`KNOWN_ACTIONS` set duplicates the union** (Day-7 debt). Three
  sources of truth for the audit-verb list. Refactor option: derive
  `KNOWN_ACTIONS` from `Object.keys(LABELS)` at module load.

- **Tender-history applications fan-out fetches 200 rows globally**
  (Day-7 debt). JS post-filter by `metadata.tenderId`. Bounded cost
  at Phase 1 scale, correctness concern past ~10k audit rows.

- **Phase-1 cross-actor visibility gap on the activity feed** (Day-7
  debt). Applicants don't see tender-level events on tenders they
  applied to; company-role users on their own company detail page
  only see their own actions, not staff-actor edits.

New as of Day 8.

- **`formatInrForError` in `lib/tenders/actions.ts` duplicates
  `formatInrAscii`.** Output is identical; the local helper exists
  because Day 8's Chunk 2 didn't have the shared module yet. Now that
  the shared module is in place and is pure (no React imports), the
  gate can use `formatInrAscii` directly. One-line edit; fold on the
  next mutation in `actions.ts`.

- **Seeded company turnover figures are all NULL.** The seed predates
  the column, so no figures landed. Not really debt - by design,
  turnover is optional - but the seeded test scenarios will need
  manual setup (or a seed update) to exercise the gate's pass-through
  branch quickly. Today's smoke test used a `better-sqlite3` script
  to set Acme's turnover to Rs. 1 crore; that worked, but a one-line
  seed addition would make repeat runs easier.

- **Heredoc-to-temp-`.cjs` DB inspection pattern is informal.** Used
  three times today. Worth wrapping as a tiny `scripts/db-inspect.ts`
  to take a SQL query string and `console.table` the result. Not
  blocking.

---

## What's next

### 1. Documents module kickoff (recommended)

The obvious next thread. R2 bucket, schema (`documents` table with
expiry tracking), presigned-URL upload flow, expiry-reminder cron
or background job. First session of a 3-4 session arc; the right
starting point is the schema + the R2 client wiring + a proof-of-
concept upload flow that lands one PDF on R2 and persists the
metadata row. UI for the documents tab on company detail comes
later in the arc.

This is the next major Launchpad capability per the project brief
and has been the "next big thread" candidate in every report from
Day 5 onward. The turnover gate landing today clears the smaller
deferred items off the table; documents is the natural follow-on.

### 2. Self-serve company registration

Public `/register` flow plus admin approval queue. Pairs naturally
with the documents module - documents are required on registration.
Could be sequenced as documents-first (so the registration flow has
something to upload into) or registration-first (and documents
become an upload-after-approval flow). The documents-first ordering
is slightly cleaner.

### 3. Smaller carry-over candidates

If a fresh thread isn't ready and the next session wants something
contained:

- Fold `formatInrForError` into `formatInrAscii` (one line, plus
  a small audit of any other places that use the local helper).
- `KNOWN_ACTIONS` derivation from `LABELS` keys (Day-7 debt).
- `scripts/db-inspect.ts` wrapper for the heredoc pattern.
- Turnover-aware tender filter on the tender list ("tenders my
  company qualifies for").

---

## How to run it locally

```powershell
# From the repo root
pnpm install
pnpm dev
# App at http://localhost:3000

# Default seeded users
# admin@consultway.local   / ChangeMe123!  (Admin role)
# staff@consultway.local   / ChangeMe123!  (Staff role)
# acme@example.local       / ChangeMe123!  (Company role, linked to Acme Construction Pvt Ltd)
```

To verify the Day 8 work end-to-end:

1. Sign in as admin. Visit `/dashboard/companies/<acme-id>/edit`.
   Scroll to the new "Commercial profile" section between Identifiers
   and Joint venture. Enter `10000000`. The live echo below the
   input should read "Rs. 1,00,00,000". Save.

2. Visit `/dashboard/companies/<acme-id>`. The detail page should
   show "Annual turnover: Rs. 1,00,00,000" in a new "Commercial
   profile" section.

3. Sign in as admin. Find a published tender (e.g. `works`). Edit it.
   Set "Minimum annual turnover (INR)" to `5000000` (Rs. 50 lakh).
   The tender form's live echo should also read "Rs. 50,00,000".
   Save.

4. Sign out and sign in as `acme@example.local`. Apply to the tender
   you just edited. Should succeed - Acme's stated Rs. 1 crore
   exceeds the Rs. 50 lakh bar.

5. As admin, set the same tender's minimum to `50000000` (Rs. 5
   crore). Withdraw Acme's existing application via the UI.

6. Back as Acme, apply again. Should be refused with: "Your stated
   annual turnover (Rs.1,00,00,000) does not meet this tender's
   minimum of Rs.5,00,00,000." No field hint - the user can't
   unilaterally fix this.

7. As admin (or via DB), clear Acme's `annual_turnover` back to NULL.
   Withdraw the application again, then re-apply. Should be refused
   with: "This tender requires a minimum annual turnover. Update
   your company's annual turnover on the company profile before
   applying." This time the error carries `field: 'annualTurnover'`.

8. Set the tender's minimum back to NULL. As Acme, apply. Should
   succeed - no minimum, no gate.

---

## Commits shipped today

```
c48e99c  feat(companies): surface annual turnover on company form and detail page (Chunk 3)
<chunk2 hash>  feat(tenders): activate annual-turnover eligibility gate on applyToTender (Chunk 2)
<chunk1 hash>  feat(db): add companies.annual_turnover for tender eligibility gate (Chunk 1)
```

Plus the Day 8 wrap commit which will contain the regenerated
project snapshot (`docs/project-tree.md` and
`docs/key-files-snapshot.md`) and this report.
