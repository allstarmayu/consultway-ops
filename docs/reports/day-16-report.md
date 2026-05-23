# Day 16 — Phase 2 kickoff: Projects (schema, list, detail)

_Date: 2026-05-23_

## Scope

The first deliverable of the Operations Suite slice — a project-tracking
surface for Consultway staff and the companies they consult on. Three
deliverable chunks, each its own commit on `dev`:

1. **Projects schema + `createProject` action + `createProjectFromTender`
   bridge.** Lands the `projects` table (migration 0011), the create
   action, and the bridge action that promotes an awarded tender into a
   brand-new project row tied back to it via `tenderId` +
   `metadata.fromTenderId` on the audit log.
2. **Project list page + `listProjects` action.** Role-aware visibility
   encoded in SQL (admin/staff see all; companies see own only), the
   filters bar + table shell, the shared `<ProjectForm>` Client
   Component, and the create page that mounts it.
3. **Project detail page + `transitionProjectStatus` + the "Create
   project from this tender" button.** Five-state lifecycle machine,
   detail page with header / overview / history surface, edit page
   gated on `fieldMode`, and the awarded-tender bridge button that
   round-trips through `createProjectFromTender` and the
   `projectExistsByTenderId` indexed lookup.

End-of-session verification: `pnpm exec tsc --noEmit` silent,
`pnpm test --run` 367/367 green every run (was 308; +59 net),
`pnpm cron:expiry-sweep` + `pnpm cron:pending-cleanup` both clean
against the dev DB after migration 0011 applied.

## What shipped

### Chunk 1 — Projects schema + create action (commit `9778465`)

**Schema additions in `lib/db/schema.ts`:**

- New `ProjectStatus` union — `planning | active | on_hold | completed
  | cancelled`. Five values; planning and on_hold the non-obvious ones,
  the other three are standard lifecycle.
- New `projects` table — id (UUID v7), name (NOT NULL, indexed for
  search), description (TEXT NULLABLE), tenderId (TEXT NULLABLE FK →
  tenders.id ON DELETE SET NULL), companyId (TEXT NOT NULL FK →
  companies.id ON DELETE RESTRICT), status (TEXT NOT NULL with $type<>
  narrowing, default `planning`), startDate / endDate (TEXT NULLABLE,
  ISO-8601 date-only), budgetInr (INTEGER NULLABLE, whole rupees),
  internalNotes (TEXT NULLABLE, staff-only), standard timestamps.
- Indexes: companyId, status, tenderId, plus a (companyId, status)
  composite for "active projects for this company" panels.

**Migration `drizzle/0011_modern_runaways.sql`:**

Clean CREATE TABLE — drizzle-kit preserved both FK cascade clauses
correctly. Applied locally via `pnpm db:migrate`; no remote DB touched.

**`lib/projects/schemas.ts`:**

- `projectStatusSchema` — closed Zod enum mirroring the type union.
- `createProjectSchema` — companyId required UUID, name required,
  status omitted (action forces `planning`), dates optional + cross-
  validated `startDate ≤ endDate` via `superRefine`, budget optional
  non-negative integer, internalNotes optional.
- `updateProjectSchema` — partial shape, all fields optional except id.
  Excludes `companyId`, `tenderId`, `status` (those are managed by the
  bridge action, the cascade, and `transitionProjectStatus`
  respectively). Cross-field date check runs against the patch alone;
  the action layer additionally checks the merged row state.
- `createProjectFromTenderSchema` — `{ tenderId }`. Action enforces the
  awarded-only + non-null-winner gates.
- `transitionProjectStatusSchema` — `{ projectId, toStatus, reason? }`.
  Used in Chunk 3.
- `listProjectsQuerySchema` — companyId / status / search filters,
  page / perPage / sortBy / sortDir. Mirrors `listTendersQuerySchema`.

**`lib/projects/actions.ts`:**

- `createProject(input)` — admin/staff only. Validates input, soft-
  checks the companyId points to a real company (friendlier error than
  the raw FK violation), inserts with status forced to `planning`,
  audits `created` on `targetType: "project"` with the identity-ish
  fields + `after.tenderId` for direct creates.
- `createProjectFromTender({ tenderId })` — admin/staff only. Loads
  the tender, refuses if status ≠ awarded or awardedCompanyId is null
  (defensive — `markAwarded` already requires the winner since Day 14,
  but the bridge double-checks rather than trusting the status flip),
  inserts the project row directly (not through `createProject`) so we
  can write a single audit event with `metadata.fromTenderId` as the
  bridge discriminator. Returns `{ ok: true, projectId }`.
- `updateProject` — admin/staff full patch; company-role users on
  their own project may patch description only (everything else is
  silently dropped + logged). Cross-field date check against the
  merged row state. No-op patches return idempotent success.
- `getProject` — single-row fetch with role-aware scoping. Returns
  "not found" for foreign-company reads (leak-safe). Strips
  internalNotes on company-role reads.
- `listProjects` — paginated/filtered list. SQL-side row scope
  (admin/staff see all; company sees own). `companyId` filter
  silently dropped from company-role queries. Search is LIKE on name.
  internalNotes stripped on company-role rows.

**Sentinel: no `deleteProject` this session.** The schema's
`tenderId → SET NULL` and `companyId → RESTRICT` cover the implicit
cases; an explicit delete action lands in a later session with its
own confirm flow.

**Tests in `lib/projects/__tests__/actions.test.ts` (+19):**

- happy-path create (admin and staff), forced `planning` status,
  audit `created` written under the right actorRole.
- companyId-not-found friendly error (`field: "companyId"`).
- startDate > endDate refusal (`field: "endDate"`).
- company-role caller refused on createProject.
- unauthenticated refused on createProject.
- createProjectFromTender happy path — composes name, description,
  companyId, tenderId from the tender row; writes `metadata.fromTenderId`.
- createProjectFromTender refuses closed-tender, awarded-without-winner
  (the defensive defensive case), company-role caller, unknown tender.
- updateProject admin patch on name + budget; before/after audit
  snapshot captures both values.
- updateProject merged-state date guard (patch ONLY startDate; the
  schema's per-patch check sees just one date, but the action's
  merged-row check catches it).
- updateProject no-op returns ok without DB write (`updatedAt`
  unchanged).
- updateProject by company-role on description-only succeeds.
- updateProject by company-role with staff-only fields in the patch
  silently drops them; only description lands.
- updateProject cross-company refusal returns "not found" (leak-safe).
- getProject strips internalNotes on company-role; admin sees them.
- getProject cross-company read returns "not found".

Total at end of Chunk 1: **327 tests** (was 308).

### Chunk 2 — Project list page + `listProjects` (commit `a76e673`)

**Surfaces:**

- `app/dashboard/projects/page.tsx` — Server Component shell. Reads
  searchParams + session in parallel, derives `canCreate` from role,
  fetches the companies list for the admin/staff filter, defers the
  table render to `<ProjectsTableSection>` behind a Suspense boundary
  keyed on serialised params. Mirrors `app/dashboard/tenders/page.tsx`.
- `_components/projects-filters-bar.tsx` — Client Component. Search
  (debounced 300ms) + status select + optional company select
  (only rendered when `companyOptions` is passed — admin/staff get
  the list; company-role doesn't). Same sentinel `__all__` pattern as
  the tenders filters bar.
- `_components/projects-table.tsx` — pure presentation given pre-
  fetched rows. Columns: Project (icon + name + "Linked to tender"
  hint), Company, Status badge, Start, End, Updated, Actions (view
  icon). Empty-state copy varies by `canCreate`.
- `_components/projects-table-section.tsx` — async fetching half.
  Calls `listProjects(query)`, additionally fetches the company-name
  map for the rendered page in one `IN (...)` lookup so the table
  doesn't N+1-fetch.
- `_components/badges.tsx` — `<ProjectStatusBadge>` with palette-
  consistent styling for the five states. Exports
  `PROJECT_STATUS_OPTIONS` so the filter bar and Chunk 3's status
  buttons stay in sync.
- `components/projects/project-form.tsx` — shared between Create and
  Edit. Inline-Zod-resolver pattern from `company-form.tsx`. Three
  sections: Identity, Schedule, Budget, and (staff-only) Internal
  notes. `fieldMode` prop gates everything except description for
  company-role users; companyId is read-only in edit mode regardless.
- `app/dashboard/projects/new/page.tsx` — admin/staff-only create
  shell; redirects company-role users to `/dashboard/projects`.
  Fetches the full companies list for the owning-company select.

**Sidebar nav:**

`components/dashboard/sidebar.tsx` already had a Projects entry
between Tenders and Transactions (added Day 4 — see the report). No
nav change needed this session.

**`listProjects` consumed:**

The action shipped in Chunk 1 got its first UI consumer here. Row
scope encoded directly in SQL (no JS post-filter), same shape the
Day-14 tenders refactor pinned. Total reflects the visible row count
exactly, no off-by-N approximations.

**Tests in `lib/projects/__tests__/list-visibility.test.ts` (+15):**

Fixture seeds 6 projects across 3 companies (Acme: 2, BuildRight: 1,
Coastal: 3) plus admin / staff / three company users.

- admin sees all 6; staff sees all 6.
- admin + companyId filter narrows to the 3 Coastal rows.
- companyA sees their 2; companyB sees their 1; companyC sees their 3.
- companyA cannot peek at companyB by passing a foreign companyId —
  the action silently drops it from company-role queries.
- internalNotes stripped for company-role.
- companyC + status=planning → 1 row (the matching Coastal planning).
- admin + status=active across all → 3 rows (one per company).
- admin + companyId + status compose correctly (single row).
- search LIKE on name finds matches; combines with scope (companyA
  searching for Coastal → 0 rows even though the name matches; scope
  beats search).
- pagination respects the SQL-side count both for admin (6 → page
  1/2 returns 2 rows) and company-role (companyC's 3 → page 1/2
  returns 2 rows).

Total at end of Chunk 2: **342 tests** (was 327).

### Chunk 3 — Detail page + state machine + tender bridge (commit `dceeb8c`)

**State machine (`lib/projects/state-machine.ts`):**

- `LEGAL_TRANSITIONS` table covers all five statuses. Forward path:
  planning → active / cancelled; active → on_hold / completed /
  cancelled; on_hold → active / cancelled. Terminals: completed,
  cancelled (no outgoing transitions).
- `isLegalProjectTransition(from, to)` — predicate used by the
  action layer.
- `illegalProjectTransitionMessage(from, to)` — hand-tuned copy for
  the common refusals (final-state, must-go-through-active for the
  planning → completed case, etc.).
- `legalNextStatuses(from)` — list of legal next statuses, used by
  the UI to decide which transition buttons to render.
- `hasAnyLegalTransition(status)` — convenience for terminal-state
  detection.

**`lib/projects/actions.ts` Chunk-3 additions:**

- `transitionProjectStatus({ projectId, toStatus, reason? })` —
  admin/staff only. Pipeline: AuthZ → Zod → load row → no-op
  short-circuit on same-status → state-machine gate → patch + audit
  with before/after status snapshot + optional `metadata.reason`.
  Same shape as `transitionTenderStatus` minus the publishedAt
  special-casing and the application-count guard.
- `projectExistsByTenderId(tenderId)` — cheap indexed existence
  check (uses `projects_tender_id_idx`). Returns `{ projectId } | null`.
  Used by the tender detail page's bridge surface to decide between
  the "Create project" button and the "View linked project" link, and
  by the Chunk-3 tests as a round-trip assertion.

**UI surfaces:**

- `app/dashboard/projects/[id]/page.tsx` — detail Server Component.
  Loads project + owning company + (optional) linked tender title in
  parallel; renders header + overview + history. History wrapped in
  Suspense.
- `app/dashboard/projects/[id]/edit/page.tsx` — admin/staff full edit
  via `fieldMode="full"`; company-role on own project via
  `fieldMode="description-only"`. `getProject` enforces row-scope so
  foreign reads land on `not-found.tsx`.
- `app/dashboard/projects/[id]/not-found.tsx` — leak-safe fallback.
- `_components/project-header.tsx` — Client Component. Role-gated
  transition buttons:
    - `planning` → Activate, Cancel, Edit
    - `active`   → Pause, Complete, Cancel, Edit
    - `on_hold`  → Resume, Cancel, Edit
    - `completed` / `cancelled` → Edit only (notes/description)
  Activate / Pause / Resume are one-click; Complete is wrapped in a
  ConfirmDialog (terminal); Cancel is wrapped with an optional-reason
  textarea (terminal + audit-worthy).
- `_components/project-overview.tsx` — four cards: Identity (with
  the linked-tender link when present), Schedule, Budget (Indian-
  locale grouped INR), Internal Notes (admin/staff-only).

**Tender → Project bridge:**

- `app/dashboard/tenders/[id]/_components/tender-to-project-bridge.tsx`
  — Client Component that renders one of two surfaces on an awarded
  tender:
    - When no project is linked AND viewer is admin/staff → "Create
      project from this tender" button. Calls
      `createProjectFromTender`, redirects to the new project's
      detail page on success; surfaces inline error on failure.
    - When a project IS linked → "View linked project" link
      (visible to everyone with tender visibility).
- `app/dashboard/tenders/[id]/page.tsx` — fetches
  `projectExistsByTenderId(tender.id)` only when status is awarded,
  passes the result down. The bridge card mounts between the header
  and the overview.

**Audit infra adjustments:**

- `components/audit/entity-history.tsx` — `targetType` union widened
  to include `"project"` so the detail page can mount the standard
  EntityHistory card.
- `lib/audit/resolve-targets.ts` — `targetHref` switch routes
  `"project"` to `/dashboard/projects/<id>` (previously fell into the
  no-link branch alongside user / transaction / document).

**Tests in `lib/projects/__tests__/state-machine.test.ts` (+25):**

Pure state-machine assertions (no DB):
- planning → active legal; planning → on_hold / completed illegal.
- active → on_hold / completed / cancelled all legal.
- on_hold → active / cancelled legal; on_hold → completed illegal.
- completed / cancelled are terminal — every outgoing transition
  refuses.
- `legalNextStatuses` returns the right set per state, empty for
  terminals.
- `hasAnyLegalTransition` true except for terminals.

Action-layer integration:
- planning → active happy path; row reflects new status.
- active → on_hold writes before/after audit with metadata.statusChange.
- on_hold → active works.
- active → completed works (terminal-positive).
- planning → cancelled captures reason metadata when supplied.
- planning → completed refused with `field: "toStatus"`; error names
  "active" as the through-state.
- planning → on_hold refused.
- completed → anything refused with "final" in the error copy.
- cancelled → anything refused.
- same-status returns idempotent ok WITHOUT writing an audit row.
- company-role refused; unauthenticated refused; admin succeeds.

Scoping + bridge:
- companyA reads own project via `getProject`; foreign-company
  project returns "not found".
- `createProjectFromTender` round-trip: pre-condition
  `projectExistsByTenderId` returns null, post-condition it returns
  `{ projectId }` matching the new project, project row's `tenderId`
  points back to the tender, audit row carries
  `metadata.fromTenderId`.

Total at end of Chunk 3: **367 tests** (was 342).

## Key decisions

**Three chunks, one migration.** All three commits sit on top of the
single Chunk-1 migration (0011). The schema is small enough that
splitting the table into pieces (e.g. "core columns now, dates later")
would be artificial process for its own sake. The action surface and
the UI surface split cleanly between chunks; the schema doesn't.

**`budgetInr` not `budgetAmount`.** Matches `tenders.minAnnualTurnoverInr`
exactly so the two compare cleanly without coercion gymnastics and so a
future financial-rollup query can `UNION` them. Multi-currency, if it
ever lands in Phase 3, is a `currency` column on the same table — not
a rename. Captured in the column docstring.

**Five-state lifecycle (planning / active / on_hold / completed /
cancelled).** The phases doc and the prompt both implied a small closed
set; I went with five rather than three because `on_hold` is the state
the Excel-and-WhatsApp workflows actually use ("we're waiting on the
client") and folding it into `active` would lose that signal.
`planning` separates "we have a row but haven't started" from "we're
running it" — useful for the dashboard's "active engagements" panel
that lands later. Two terminals (completed / cancelled) instead of
one means the audit trail differentiates successful wraps from
contract terminations.

**No `deleteProject` action this session.** Deliberate. The schema's
cascade rules (tenderId → SET NULL on tender delete; companyId →
RESTRICT on company delete) cover the implicit cases. A standalone
delete needs its own confirm flow, an R2-cleanup story for any
attached docs (when documents-on-projects lands), and a soft-delete-
vs-hard-delete design pass. Better to surface this as a deliberate
later-session task than to ship a half-formed delete.

**`createProjectFromTender` writes its own audit event with a bridge
discriminator.** Could have composed it as `createProject(...)` and
inherited the standard `created` event. Rejected — a project promoted
from a tender is forensically distinct from one created manually, and
the only place that distinction is queryable later is the audit log.
A single `metadata.fromTenderId` field on the create event makes
"show me every project that came from a tender" one filter; the
composed-call alternative would force a join through `projects.tenderId`
which is fine but slower and easier to miss.

**Bridge button gates on `projectExistsByTenderId` + visibility on
`tender.status === awarded`.** The button never appears on draft /
published / closed tenders — those don't have a winner to promote.
The lookup is keyed on the `projects_tender_id_idx` so it's cheap
enough to run on every awarded-tender render (one indexed equality
query). When a project is linked, the same surface renders the
"View linked project" link to everyone, not just staff — anyone with
tender visibility benefits from the cross-link.

**Defensive `awardedCompanyId is null` check in the bridge.** Belt-
and-braces. `markAwarded` already requires the winner since Day 14,
so a tender in `awarded` status without an `awardedCompanyId` is
genuinely corrupted state (hand-edit, broken migration, etc.). Rather
than silently writing a project with a NULL owner (which the NOT NULL
on `projects.companyId` would reject anyway), surface a clear error.
Pinned by a test that constructs the corrupted state directly.

**Company-role updateProject limited to description.** The phases doc
allowed company-role users to "comment on project" but didn't spell
out what fields they can patch. Defaulted to description-only — the
work-summary field is the place where the company knows more than
Consultway (status of their internal team's progress, technical
notes); everything else is Consultway-managed. Other fields silently
dropped on the patch with a log line — defence in depth, since the
form already disables them.

**`<ProjectStatusBadge>` lives in `app/dashboard/projects/_components`
not `app/dashboard/_components`.** Mirror of the tenders module —
each domain owns its visuals, no shared cross-module badges file. The
duplicated CVA-style config is intentional; it's cheaper than the
abstraction cost of a shared "EntityStatusBadge" generic.

**`projectExistsByTenderId` exported from a "use server" file.**
Technically becomes a remote-callable Server Action, which widens the
surface area minimally. Acceptable here because anyone with tender
visibility can already determine via `listProjects` (with admin/staff)
or the audit log whether a project exists; the function is a read-
only existence check, not sensitive. If we ever tighten public
Server Actions, this is a candidate for moving to a private
non-"use server" helper module.

## Gotchas surfaced

**`projects.tenderId` index is the load-bearing one for the bridge.**
Without `projects_tender_id_idx`, the bridge would do a full table
scan on every awarded-tender render. Adding it in the same migration
keeps `projectExistsByTenderId` cheap from day one — worth a
forward-looking index even when the table is empty.

**Drizzle's INTEGER booleans don't round-trip via `$type<boolean>`
for `$inferInsert`.** Not project-specific — bit us once on the
companies-form check during the type pass. Worked around by relying
on Drizzle's `$type<>` narrowing on the column rather than declaring
the type at the schema layer. No code change needed; the lesson is
the schema's `$type<ProjectStatus>` narrowing is what the action's
typed patch object inherits — declaring `Partial<typeof projects.$inferInsert>`
gives the union back.

**No-op transition must NOT write an audit row.** Pinned by a test.
Without the same-status short-circuit, every same-status submit
would clutter the audit log with `before === after` events. The
matching code is one early-return line; easy to drop in a refactor —
worth a test.

**Cross-field date guard fires twice — schema (patch-local) AND
action (merged row state).** The schema's `superRefine` only sees the
patch in isolation. A test pins the case where the patch sends
`startDate` later than the existing `endDate` — Zod passes (only one
date in scope), the action catches it. Same pattern `updateTender`
uses; preserved here.

**`entity-history.tsx`'s `targetType` union was closed at two
values.** Widening to three (adding `project`) was the minimal
change. The downstream `resolveReferences` resolver had a stub case
for "project" but the `targetHref` switch had been routing to "no
link". Both got the small lift in this session — the resolver could
benefit from a proper per-project name resolution (one IN-query like
the company/tender batches do), but the current placeholder
("project {truncated-id}") is bearable for the audit feed inside the
project's own detail page (the page header already shows the name).
Listed below as a followup.

**Migration 0011 is a CREATE TABLE — no FK cascade quirks.** Day-14's
ALTER TABLE ADD COLUMN cascade-stripping bug didn't recur here.
Generator output was clean; no hand-edits.

## Surfaces touched

```
# Chunk 1 — Projects schema + create action (commit 9778465)
drizzle/0011_modern_runaways.sql                                    (new — projects table)
drizzle/meta/0011_snapshot.json                                     (new — drizzle-kit generated)
drizzle/meta/_journal.json                                          (modified — drizzle-kit generated)
lib/db/schema.ts                                                    (modified — projects table + ProjectStatus union)
lib/projects/__tests__/actions.test.ts                              (new — 19 tests)
lib/projects/actions.ts                                             (new — createProject, createProjectFromTender, updateProject, getProject, listProjects)
lib/projects/schemas.ts                                             (new — Zod schemas)

# Chunk 2 — Project list page + listProjects (commit a76e673)
app/dashboard/projects/_components/badges.tsx                       (new — ProjectStatusBadge + PROJECT_STATUS_OPTIONS)
app/dashboard/projects/_components/projects-filters-bar.tsx         (new — search + status + company filter)
app/dashboard/projects/_components/projects-table-section.tsx       (new — async data half)
app/dashboard/projects/_components/projects-table.tsx               (new — presentational table)
app/dashboard/projects/new/page.tsx                                 (new — admin/staff-only create shell)
app/dashboard/projects/page.tsx                                     (new — list page Server Component)
components/projects/project-form.tsx                                (new — shared form, create + edit modes)
lib/projects/__tests__/list-visibility.test.ts                      (new — 15 tests)

# Chunk 3 — Detail page + state machine + tender bridge (commit dceeb8c)
app/dashboard/projects/[id]/_components/project-header.tsx          (new — Client Component with transition buttons)
app/dashboard/projects/[id]/_components/project-overview.tsx        (new — four-card overview)
app/dashboard/projects/[id]/edit/page.tsx                           (new — edit shell with role-gated fieldMode)
app/dashboard/projects/[id]/not-found.tsx                           (new — leak-safe fallback)
app/dashboard/projects/[id]/page.tsx                                (new — detail Server Component)
app/dashboard/tenders/[id]/_components/tender-to-project-bridge.tsx (new — Create/View bridge card)
app/dashboard/tenders/[id]/page.tsx                                 (modified — mount the bridge on awarded tenders)
components/audit/entity-history.tsx                                 (modified — targetType union widened)
lib/audit/resolve-targets.ts                                        (modified — targetHref for "project")
lib/projects/__tests__/state-machine.test.ts                        (new — 25 tests, includes the round-trip bridge test)
lib/projects/actions.ts                                             (modified — transitionProjectStatus, projectExistsByTenderId)
lib/projects/state-machine.ts                                       (new — five-state transition machine)

# Day 16 report (this commit)
docs/reports/day-16-report.md                                       (new)
```

## Test totals

Before this session: **308 tests across 14 files**, all green (Day
15 end state).

After this session: **367 tests across 17 files**, all green every
run. Net: **+59**.

Breakdown of the delta:

- +19: `lib/projects/__tests__/actions.test.ts` (Chunk 1)
- +15: `lib/projects/__tests__/list-visibility.test.ts` (Chunk 2)
- +25: `lib/projects/__tests__/state-machine.test.ts` (Chunk 3)

The brief budgeted ~34–42 new tests; landed at +59. The state-machine
matrix accounts for the overshoot — the five-state table has 20
non-diagonal cells and even the spot-checks for the legal-vs-illegal
split adds up. No existing test files needed editing; the audit
resolver and entity-history changes were small enough not to need a
dedicated test (covered indirectly via the EntityHistory render path).

## Followups for Day 17+

**From this session:**

1. **`deleteProject` action.** Needs its own confirm flow, R2-
   cleanup story for project-attached docs (when those land), and a
   soft-delete-vs-hard-delete design pass. Deliberately deferred.
2. **Per-project name resolution in `lib/audit/resolve-targets.ts`.**
   The audit feed currently surfaces "project {truncated-id}" for the
   target label. Easy lift — add a `projectNameById` batch lookup
   alongside the existing company/tender batches. Worth doing before
   the audit feed widget surfaces projects in the dashboard overview.
3. **Project-attached documents.** The schema doesn't currently link
   documents to projects (only to companies). When the project
   documents surface lands, the FK is the small change; the bigger
   work is the upload UI and the role-gated access rules.
4. **Side-by-side detail view at desktop widths.** Same carry-forward
   from earlier sessions — the project detail page's four-card
   overview would benefit from a 3-column layout on `xl:` widths.
5. **Project list export-to-CSV.** Same shape as the companies CSV
   export; trivial when added.
6. **Project dashboard widget.** A "projects by status" KPI card on
   the admin dashboard. Cheap once the SQL groupBy is wired.
7. **Searchable companies select in `<ProjectForm>`.** Phase 1 scale
   (<200 companies) the full list works fine. When the roster grows,
   swap to a typeahead-search Server Action — same pattern noted for
   the tender form's publisher picker.

**Carried forward from Day 15 (unchanged):**

8. **Session invalidation on password reset.** `passwordChangedAt`
   timestamp + proxy check. Phase-3 hardening.
9. **Multi-step registration UX.** Wizard UI for `/register`.
10. **CAPTCHA / rate limiting** on `/register`, `/forgot-password`,
    and the token-consume endpoints.
11. **Public tender browsing** for unauthenticated visitors.
12. **Token cleanup cron.** Both email-verification and password-reset
    tables grow append-only.
13. **Hoist `escapeHtml` to a shared helper** (five copies across email
    templates).
14. **`@opennextjs/cloudflare` install + `open-next.config.ts`.**
15. **D1-backed Drizzle client factory.**
16. **Resend domain verification + production secret.**
17. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
18. **Side-sheet vs side-by-side detail view at desktop widths.**
19. **Seed self-healing on changed fixtures.**
20. **Stage real fixtures into R2** for demo download paths.
21. **drizzle-kit ALTER TABLE ADD COLUMN cascade-clause gotcha.** Did
    NOT surface this session (migration 0011 was CREATE TABLE), but the
    underlying generator bug is still there for the next ALTER TABLE
    migration that adds an FK column.
22. **`docs/05-database-schema.md` rebaseline.** Day 14 noted the
    tenders table was out of sync; Day 15 added the two token tables;
    Day 16 adds `projects`. The doc is now three sessions behind on
    its schema reflection. Doc-pass session due.

**Already-resolved this session:**

- Long-standing "no project tracking" gap — Phase 2/3 entry point now
  has a working surface. Admins/staff can create projects directly or
  promote awarded tenders into projects; companies can read and
  description-edit their own.
- The audit log's `project` targetType (declared Day 6) finally has
  callers writing rows under it.

## Carry-forward to Day 17

- **`dev` ended at 4 commits past Day 15's report** (Day 15's report
  commit was `5393e15`; this session's commits are `9778465` /
  `a76e673` / `dceeb8c` plus this report's commit). Run
  `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing still requires explicit approval per `<permissions>`.
- **367 tests passing on every run.** Three new test files added; no
  existing test files needed editing; no flakes.
- **Migration 0011 applied to dev DB.** `projects` table present.
  `pnpm db:reset` would rebuild from scratch correctly via the
  migrations chain.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` from the Day-12 dedup row. Expected;
  not a regression.
- **`pnpm cron:pending-cleanup`** clean (`deletedCount=0`).
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 16 didn't
  add new emails so this didn't surface.
- **`PASSWORD_PEPPER`** unchanged.
- **`AuditTargetType` `project`** now has live callers. The audit-row
  resolver renders the placeholder label ("project {truncated-id}")
  for now; the per-project batch lookup is followup #2 above.
- **`projectExistsByTenderId`** is exposed as a Server Action (it lives
  in a "use server" file). Considered minor — any tender-visible
  caller can already determine the same fact via `listProjects` (for
  admin/staff) or the audit log. If we tighten public Server Actions
  later, this is a candidate to move to a private helper.

That's Day 16.
