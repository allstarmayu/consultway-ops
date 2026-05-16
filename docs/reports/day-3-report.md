# Consultway Ops — Day 3 Report

**Date:** May 15, 2026
**Author:** Mayur (with Claude as engineering partner)
**Branch:** `dev`
**Commits:** 11 new commits on top of Day 2's foundation

---

## Executive summary

Day 3 turned the Consultway Ops portal from a "you can log in" demo into a working
companies module. By end of day, a Consultway staff member can sign in, browse
the full company roster with search and filters, register a new company through
a guided form, view a clean per-company profile, edit any field, and (as admin)
permanently remove companies through a deliberate confirmation flow. Every
mutating action is also captured by the audit logger so we know who changed what
and when.

Eleven commits shipped to `origin/dev`. The application is in a stable,
demonstrable state and is the right point to walk through with the Consultway
team for feedback before extending into tenders, documents, or projects.

---

## What works today

### Authentication and access control

- Email + password login with bcrypt hashing and a server-side pepper
- JWT session cookies (HttpOnly, signed, 7-day expiry) verified on every
  protected request
- Route-level protection via Next.js proxy — unauthenticated visits to
  `/dashboard/*` redirect to `/login`, authenticated visits to `/login`
  redirect to `/dashboard`
- Role-based access enforced at three layers: page (which routes load),
  action (which mutations are allowed), and row (which records a user can see)

### The companies module — full lifecycle

| Capability | Where | What it does |
| --- | --- | --- |
| Browse | `/dashboard/companies` | Paginated table, free-text search on name, filters by sector / geography / compliance status / JV / MSME, sort by any column |
| Add | `/dashboard/companies/new` | Six-section form with on-blur validation, JV partner picker (typeahead with chips), MSME and JV toggles, sticky submit bar, unsaved-changes guard |
| View | `/dashboard/companies/[id]` | Read-only fact sheet across the same six sections, clickable JV partner chips for cross-record navigation, role-gated action buttons in the header |
| Edit | `/dashboard/companies/[id]/edit` | Reuses the same form pre-populated with current values, redirects to the detail view on save |
| Delete | `/dashboard/companies/[id]/delete` | Dedicated confirmation page with a type-the-name-to-confirm safety, admin-only access, destructive-style submit button |

The form handles every field the Consultway team flagged as important: legal
name, sector, geography, GSTIN, PAN, MSME registration, JV structure with
multiple partners, primary contact (person / email / phone), full registered
address, and admin-only internal notes that the company itself never sees.

### Joint ventures

JVs are first-class records — same shape as standalone companies, with a flag
and a list of partner company IDs. The detail page renders partners as clickable
chips that navigate to each partner's own detail page. When editing a JV, the
partner picker excludes the JV itself from the list of selectable partners (a
company can't be its own parent). The schema enforces a minimum of two partners
when the JV flag is on, and zero when it's off, both client-side and on the
server.

### Audit logging

Every create, update, and delete now produces a structured audit event capturing:
- Who acted (user id + role)
- What action (created / updated / deleted)
- Which record (target type + id)
- A before-and-after snapshot of the touched fields (for updates), the
  identity fields (for creates), or the full pre-deletion row (for deletes)

The audit log is currently a structured log line — when the audit_log table
ships in a future chunk, the call sites are already in place and only the
storage layer changes.

### Design polish

- Custom "Warm Ambient" palette (cream backgrounds, espresso text, terracotta
  accents) applied across the entire internal portal — distinct from the
  navy/red marketing site for Consultway's external clients
- Consistent header pattern with title, subtitle, and action buttons across
  every page
- Loading skeletons that match the final layout, so pages don't jump when
  content streams in
- Empty states, not-found pages, and error fallbacks handled with the same
  visual language as the rest of the app

---

## What's intentionally deferred

These are tracked items, not gaps — each has a known reason for not landing
today.

| Item | Why deferred |
| --- | --- |
| Compliance-status editing in the form | Compliance is a deliberate state transition (pending → compliant / non-compliant / expired) that deserves its own workflow, not a buried checkbox on the edit form |
| Document upload & expiry reminders | Phase 1B — requires R2 storage setup and a scheduled job for expiry sweeps |
| Tender management | Day 4+ — depends on the companies module being stable, which it now is |
| Project tracking & financial transactions | Phase 2 — explicitly scoped out of the MVP |
| Email notifications | Phase 1B — requires Resend setup and template authoring |
| Company self-registration portal | Phase 1B — admin-led onboarding is sufficient for the initial rollout |
| Permanent audit log table | Foundation shipped today (structured logs); persistent table comes when the first real audit query is needed |
| Rate limiting on login | Phase 1B — current threat surface is low (private deploy, known users) |
| JWT revocation blocklist | Phase 1B — short token TTL (7 days) is acceptable for the initial rollout |

---

## Known technical debt

Small items flagged during development for follow-up.

- **Timestamp format inconsistency.** SQLite's `datetime('now')` produces
  `"2026-05-15 22:14:33"` (space-separated) while JavaScript's `toISOString()`
  produces `"2026-05-15T22:14:33.000Z"` (ISO-8601). Both parse fine but they
  look inconsistent in raw queries. Will normalise to ISO-8601 across the
  board in Day 4.

- **`Get-ChildItem` and the `[id]` folder.** PowerShell treats `[id]` as a
  wildcard, so listing the folder requires `-LiteralPath`. Documented in
  developer notes; doesn't affect the application.

- **`partner-picker.tsx` location.** The picker lives at
  `app/dashboard/companies/new/_components/` but is imported by the shared
  `CompanyForm` in `components/companies/`. Works fine; would be tidier if
  moved to `components/companies/` as well. Cosmetic, deferred.

---

## What's next

Day 4 will start the tenders module. The companies module is stable enough to
serve as the dependency it'll need (tenders require a publisher, an
eligibility filter set, and a way to track which companies have applied).

Suggested Day 4 scope:
1. **Tenders schema** — table, FKs to companies, indexes
2. **Tender Server Actions** — create / update / publish / unpublish / apply
3. **Tenders list page** — table view, filters by status / sector / closing date
4. **Tender detail page** — read view + apply action for company-role users
5. **Audit hooks wired in** (mirrors what we did for companies)

That's a comparable scope to Day 3 and should land in one focused session.

---

## How to run it locally

```powershell
# From the repo root
pnpm install
pnpm dev
# App at http://localhost:3000

# Default seeded users
# admin@consultway.local  / ChangeMe123!  (Admin role)
# staff@consultway.local  / ChangeMe123!  (Staff role)
```

Seeded data includes five demo companies — three standalone (Acme Construction
Pvt Ltd, BuildRight Engineers, GreenTech Solutions) and two JVs (Acme-BuildRight
JV, Modern-Alpha Alliance). Compliance state covers all three primary statuses
(compliant / pending / non-compliant) so the filter dropdowns have realistic
content to filter against.

---

## Commits shipped today

```
daf446b  feat(companies): add detail page, edit form, and delete confirmation
4b22a10  feat(companies): add create-company form with sectioned layout and audit stub
c98fea6  feat(seed): add five demo companies (3 standalone + 2 JVs)
5c0571f  feat(dashboard): add sidebar shell and companies list page
05222b3  feat(theme): swap to Warm Ambient palette for the ops portal
bccd01e  feat(companies): add Zod schemas and Server Actions
8c754e7  feat(db): add FK from users.company_id to companies.id
9a87a4d  feat(db): add companies table with sector/geography/compliance indexes
4636c37  chore(tooling): snapshot script now walks lib/ and app/ recursively
1097076  feat(auth): add route protection via middleware and dashboard stub
76bc963  feat(auth): add login page and Server Action with JWT session cookies
```

Plus the Day 3 wrap commit which contains the `middleware.ts → proxy.ts`
rename (Next.js 16 convention update), removal of the throwaway debug script
`scripts/check-db.mjs`, the regenerated project snapshot, and this report.
