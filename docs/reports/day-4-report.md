# Consultway Ops — Day 4 Report

**Date:** May 16, 2026
**Author:** Mayur (with Claude as engineering partner)
**Branch:** `dev`
**Commits:** 7 new commits on top of Day 3's foundation

---

## Executive summary

Day 4 turned the Consultway Ops portal into a working tender management
platform. By end of day, a Consultway staff member can sign in, create
a tender draft through a guided six-section form, publish it for
companies to discover, watch applications come in, shortlist or reject
them inline, close the application window, and mark the tender as
awarded. A registered company can log in, see published tenders they're
eligible for, apply with an optional cover note, see staff's decisions
on their application, and withdraw if they change their mind. Every
mutation is captured by the audit logger.

Seven commits shipped to `dev`. The tenders module is in a stable,
demonstrable state and is the natural place to walk through with the
Consultway team for feedback before extending into documents, projects,
or financial transactions.

---

## What works today

### Schema and migrations

- New `tenders` table with status lifecycle (draft → published → closed
  → awarded), eligibility filters (sector, geography, min annual
  turnover INR, MSME-only flag), opening/closing dates, internal notes,
  and a publisher FK to the companies table
- New `tender_applications` join table with per-application status
  (submitted, withdrawn, shortlisted, rejected), cover note,
  staff-internal notes, and submitted/decided timestamps
- Composite unique index `(tender_id, company_id)` on applications —
  one application per company per tender, enforced at the DB level
- Cascade semantics: deleting a draft tender wipes its applications;
  deleting a company wipes its applications. Publisher FK is
  `ON DELETE RESTRICT` so a company with published tenders cannot be
  silently removed
- Sentinel "Consultway Infotech" company seeded as the default publisher
  for internal tenders — saves the create flow from needing a publisher
  picker in the common case

### The tenders module — full lifecycle

| Capability | Where | What it does |
| --- | --- | --- |
| Browse | `/dashboard/tenders` | Paginated table, free-text search on title, filters by status / sector / geography / MSME-only, sort by any column, relative-time closing-date column with overdue / closing-soon emphasis |
| Add | `/dashboard/tenders/new` | Six-section form: Identity, Categorisation, Eligibility filters, Application window, Publisher (advanced toggle for subcontract tenders), Internal notes. Sticky action bar, unsaved-changes guard, live Indian-locale grouped echo on the turnover input |
| View | `/dashboard/tenders/[id]` | Four overview cards plus applications table. Status badge in header. Role-gated action buttons (Publish / Unpublish / Close / Mark awarded / Edit / Delete) |
| Edit | `/dashboard/tenders/[id]/edit` | Reuses the same form pre-populated with current values. State-machine-driven field gating disables eligibility filters once published and locks everything except internal notes once closed/awarded. Banner explains why fields are locked |
| Delete | `/dashboard/tenders/[id]/delete` | Type-the-title-to-confirm safety. Admin-only. Drafts only — non-drafts get an explainer redirecting to close/award workflows |

### Status transitions

- Centralised state machine in `lib/tenders/state-machine.ts` —
  single source of truth for which transitions are legal and which
  fields are editable in each status
- Legal transitions: draft → published, published → draft (only when
  no applications exist), published → closed, closed → awarded
- Award is terminal — no further transitions allowed
- Unpublish is gated server-side on application count, even withdrawn
  applications block it (audit-trail rule). Surface error: "Cannot
  unpublish — N companies have already applied. Close the tender instead."

### Applications

- Companies see published / closed / awarded tenders in the list;
  drafts are hidden unless the company is the publisher (subcontract
  case)
- Apply button checks eligibility client-side as an advisory (saves
  filling in a cover note for nothing); the Server Action re-checks
  everything authoritatively. Turnover gate is wired but deferred
  pending the `companies.annualTurnover` column
- Withdraw application closes the loop on the company side — only
  permitted while still `submitted`, preserves the audit trail for
  later staff review
- Staff see all applications on the detail page; company users see
  only their own application. Inline Shortlist / Reject icon buttons
  for staff; status changes captured in the audit log with from→to
  diffs

### UI polish

- Themed confirmation dialog (`<ConfirmDialog>`) replaces every
  `window.confirm()` call. Built on shadcn AlertDialog so it inherits
  the Warm Ambient palette. Used for Mark awarded (terminal) and
  Withdraw application (irreversible)
- Pending state holds the dialog open while the Server Action runs —
  the user sees their click was received instead of a flickering
  modal that closes before the network settles
- Scoped text-selection policy on the dashboard root — clicking a
  tender title or sidebar item no longer drops a blinking text caret
  into the page. Selection re-enabled on copy-worthy fields
  (description prose, reference numbers, internal notes, application
  cover notes) so staff can still paste content into emails or
  evaluation docs
- Loading skeletons match each page's final layout — list, detail,
  new — so the viewport doesn't jump when content streams in
- Empty states, not-found pages, and error fallbacks use the same
  visual language as the rest of the app

### Audit logging

Every state-changing tender action calls `recordAuditEvent`. The
audit log captures who did what to which tender, plus before/after
snapshots:

- `created` on tender create
- `updated` on tender edit, application status change, and reversible
  transitions (unpublish, close)
- `tender_published` on publish (dedicated action verb for easier
  filtering)
- `tender_applied` on a company application
- `deleted` on tender delete (with full pre-deletion snapshot)

Read actions don't audit — would be too noisy and not legally useful.

### Design polish

- Tender status badges (four states) and application status badges
  (four states) use the Warm Ambient palette consistently with the
  Day-3 compliance badges
- Eligibility chips on the detail page surface sector / geography /
  MSME / turnover requirements at a glance
- Relative date phrasing on the closing column ("Closes in 3 days",
  "Closes today", "2 days overdue", "Closed 5 days ago") with
  status-aware tone (destructive red when overdue or closing today,
  accent when closing within a week)

### Test user for end-to-end flows

- Seeded `acme@example.local` (password `ChangeMe123!`) as a
  company-role user linked to "Acme Construction Pvt Ltd". Enables
  walking the apply/withdraw flow without manually wiring a
  user/company link from the DB

---

## What's intentionally deferred

| Item | Why deferred |
| --- | --- |
| Reversal of irreversible actions (reopen closed, retract award, restore deleted) | Headline open question — see "What's next" below |
| Turnover eligibility enforcement | Requires `companies.annualTurnover` column. Field shown in tender UI; gate currently stubbed in `applyToTender` |
| Awarded-company FK on tenders | Phase 2 concern — links tenders → projects once project tracking lands. Today the winner goes in `internalNotes` |
| Permanent audit log table | Day 3 deferred this; Day 4 just kept adding `recordAuditEvent` call sites. The storage swap is a body change in `lib/audit/log.ts`, all call sites stay |
| Hide Consultway sentinel from the public companies roster | The sentinel publisher row shows up in `/dashboard/companies` alongside real client companies. Cosmetic; cleanup lands when we revisit the companies module |
| Document attachments on tenders | Phase 1B — same R2 storage setup that documents on companies needs |
| Email notifications on application status changes | Phase 1B — Resend setup is pre-req |
| Audit log UI surface (per-tender history view) | Once the audit table lands, we surface a "History" tab on the detail page |
| Dialog component (Radix Dialog) for non-confirm modals | Apply form is currently inline-collapsible. Modal version waits until we have a second use case |

---

## Known technical debt

Small items flagged during development for follow-up.

- **Company-role drafts visibility uses JS post-filter.** `listTenders`
  filters out other-publishers' drafts in JavaScript after the DB
  query, rather than expressing the OR clause in SQL. At Phase 1's
  scale (<100 tenders) this is correct and fast. Long-term fix is a
  proper `or(neq(status, 'draft'), eq(publisherCompanyId, scope))`.

- **Timestamp format inconsistency continues.** Day 3 flagged this and
  Day 4 didn't fix it. SQLite's `datetime('now')` produces
  `"2026-05-15 22:14:33"` while JS's `toISOString()` produces
  `"2026-05-15T22:14:33.000Z"`. Both parse, both render correctly via
  the `formatTimestamp` helper, but the raw DB rows look inconsistent.
  Tracked.

- **Idempotency-by-email leaked a broken seed row.** During Day-4
  development a partial seed left `acme@example.local` in the DB with
  `company_id = null`. The new seed step skipped re-creation because
  the email already existed. Recovered by deleting the bad row and
  re-running. Lesson: when seed schema changes, idempotency keys
  should include the discriminating column too, or we add a "repair"
  pass that fills in missing columns rather than skipping.

- **markAwarded doesn't capture the winner.** Staff record the winning
  company in `internalNotes` until Phase 2's `awardedCompanyId` column
  ships. The structured audit log captures who flipped the status and
  when, but not who won.

- **Publisher options query is run on the edit page too.** The form
  hides the publisher section in edit mode but the page still fetches
  the full company list. Cosmetic — saves a few hundred bytes if we
  skip — but the symmetry with `/new/page.tsx` is more valuable than
  the optimisation.

- **Sentinel publisher in the companies roster.** Consultway Infotech
  shows up in `/dashboard/companies` alongside real client companies.
  Either filter it out at the action level or add an `is_sentinel`
  flag. Cosmetic, deferred.

- **Status-bar action buttons could be a dropdown.** The detail page
  header shows up to four buttons at once (Unpublish / Close / Edit
  or Mark awarded / Edit). On narrow viewports they wrap. Could
  consolidate into an "Actions" dropdown menu later; for Phase 1 the
  inline buttons are clearest.

---

## What's next

Day 5's headline thread is **reversal capability** — letting admins
recover from accidental status changes (closing a tender too early,
retracting an award, undoing a staff rejection). The current state
machine treats `closed → published`, `awarded → *`, and the
application transitions as one-way. That's clean but unforgiving.

The leading design is to **relax the state machine** rather than
introduce soft deletes:

- Admin can reopen a closed tender → published (with a ConfirmDialog
  warning that applicants who saw it close will be confused)
- Admin can retract an awarded tender → closed (with a stronger
  ConfirmDialog and a required "reason" textarea captured in the
  audit log)
- Admin/staff can flip a shortlisted or rejected application back to
  submitted
- A company can recall a withdrawn application within 7 days of the
  withdrawal (and never past that window)
- Delete stays final — the type-to-confirm friction plus the
  draft-only restriction are the safety net; soft delete is a
  larger surface area that warrants its own design pass

Other Day 5 candidates (any one is a reasonable thread):

1. **Reversal capability** (above) — admin-led recovery from
   accidental clicks
2. **Companies turnover field** — add the column, enable the tender
   eligibility gate, surface turnover in the companies form
3. **Audit log table** — persistent storage for `recordAuditEvent`,
   plus a per-record history tab on detail pages
4. **Documents module** — Phase 1B kickoff, R2 setup, upload UI,
   expiry reminders cron
5. **Reports module** — initial dashboard widgets, tender pipeline
   chart, applications-by-status breakdown

That's a comparable scope to Day 4 and should land in one focused
session.

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
# acme@example.local       / ChangeMe123!  (Company role, linked to Acme Construction)
```

Seeded data now includes:

- Six companies (the Day-3 five plus the Consultway Infotech sentinel)
- Three users (admin / staff / company)
- Zero seeded tenders — create your own from the UI to exercise the
  module

To walk the full flow:

1. Sign in as admin, visit `/dashboard/tenders/new`, create a tender,
   publish it
2. In an incognito browser, sign in as Acme, visit the same tender,
   apply with a cover note
3. Switch back to admin, refresh, shortlist the application
4. Close the tender, then mark awarded — both actions show the
   themed ConfirmDialog
5. Try to delete a published tender → see the explainer redirecting
   to close/award workflows instead

---

## Commits shipped today

```
b37b13b  feat(ui): scoped text-selection policy for the dashboard
885198b  feat(seed): add company-role test user linked to Acme Construction
dfeb085  feat(tenders): add detail, edit, delete, and apply flows with themed confirmations
0ff1dc8  feat(tenders): add create form with six-section layout and audit-aware submit
a25ed05  feat(tenders): add list page with filters, table, and shared pagination
e9591a0  feat(tenders): add Zod schemas, state machine, and Server Actions
61cc176  feat(db): add tenders and tender_applications tables
```

Plus the Day 4 wrap commit which contains the regenerated project
snapshot and this report.
