# Day 23 — Compliance state machine + rejectionReason UI

_Date: 2026-05-23_

## Scope

Four committed deliverable chunks closing the Day-22 compliance
followups (#1, #3, #4 in that report's followup list). The widened
ComplianceStatus union from Day 22 finally gets a transitions table at
the action layer, the audit log gains a verb that distinguishes state
moves from routine field edits, and the `rejection_reason` column lands
on the company detail page UI for admin/staff.

1. **State-machine module.** New `lib/companies/state-machine.ts`
   mirrors the projects + tenders pattern: an exhaustive
   `COMPLIANCE_STATUS_TRANSITIONS` table, a `canTransitionCompliance`
   predicate, an `assertTransitionCompliance` throwing helper, and a
   `ComplianceTransitionError` carrying both states for log grep.
   Same-state "transitions" are no-ops (don't throw); `rejected` is
   terminal (zero outbound transitions). Pinned by an 83-test
   cross-product matrix.
2. **State machine wired into `updateCompany`.** The action now
   consults `assertTransitionCompliance` BEFORE staging any
   `complianceStatus` patch. Illegal moves return
   `{ ok: false, field: 'complianceStatus', error }` instead of
   throwing; legal moves emit the new
   `compliance_status_changed` audit verb (already in the
   `AuditAction` union since Day 6) instead of plain `updated`. The
   schema gains a superRefine binding the `rejected ⇒ rejectionReason
   required` contract — a patch flipping status to `rejected` without
   a populated reason is rejected at the schema layer with
   `field=rejectionReason`. Company-role callers still have
   `complianceStatus` silently stripped, so the state-machine path
   isn't reached.
3. **Integration tests for the seed-driven state-change path.** Eight
   new tests in `lib/companies/__tests__/state-transitions-integration.test.ts`
   set up rows the same way the seed does (direct INSERT at every
   starting status, with `rejectionReason` populated on rejected rows)
   and exercise real transitions through `updateCompany`. Pins the
   `compliance_status_changed` audit verb, the rejected-as-terminal
   contract (every outbound transition refused, row preserved), and
   the `suspended → compliant` reversibility from the Day-22 spec.
4. **`rejectionReason` callout on the company detail page.** A new
   destructive-tinted `<Alert>` renders below the header strip when an
   admin/staff viewer is looking at a rejected company. Built on the
   existing `components/ui/alert.tsx` primitive (`<Alert
   variant="destructive">`) with a `Ban` icon, "Rejection reason"
   title, and the reason text as the description. Company-role
   viewers do NOT see the callout — defence in depth via both the
   `viewerRole` prop check and the new field-strip in `getCompany` /
   `listCompanies` that nulls `rejectionReason` alongside
   `internalNotes`.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 592/592 green (was 487; +105 from four new files
under `lib/companies/__tests__/`); `pnpm db:seed` re-run against the
existing `large` DB → every row logged as `unchanged` (state machine
is dormant when fixtures don't change status, and the seed never
transitions existing rows); `pnpm seed:verify` clean; `pnpm build`
compiles cleanly with no errors / warnings (proxy for the UI changes
since I can't render a browser).

## What shipped

### Chunk 1 — `lib/companies/state-machine.ts` (commit `4bb81dd`)

**Transitions table.**

```ts
export const COMPLIANCE_STATUS_TRANSITIONS: Record<
  ComplianceStatus,
  ReadonlySet<ComplianceStatus>
> = {
  pending:       new Set(["compliant", "non_compliant", "rejected"]),
  compliant:     new Set(["non_compliant", "expired", "suspended"]),
  non_compliant: new Set(["compliant", "suspended"]),
  expired:       new Set(["compliant", "non_compliant", "suspended"]),
  suspended:     new Set(["compliant", "non_compliant"]),
  rejected:      new Set(),                       // terminal
};
```

Encodes the table from the Day-23 session-opening prompt verbatim:

- `pending → rejected` allowed (intake-time rejection). `pending →
  expired` and `pending → suspended` are not — both states are
  meaningful only on an operating relationship.
- `compliant → pending` / `expired → pending` not allowed — pending is
  a one-time intake state, never a regression target.
- `rejected` is terminal — a re-engagement is a NEW company row, not a
  reanimation of the rejected one.
- `suspended ↔ compliant` reversible per the Day-22 spec.
- `compliant → rejected` NOT allowed — route through `non_compliant` or
  `suspended` first; rejection is intake-time only.

**Same-state behaviour.** `canTransitionCompliance(s, s)` returns
`true` and `assertTransitionCompliance(s, s)` does not throw. Same
convention as `lib/projects/state-machine.ts` — callers can pass the
same status without special-casing, and the action layer separately
suppresses the audit verb on a no-op (see Chunk 2).

**`ComplianceTransitionError`.** Custom Error subclass carrying both
`from` and `to` as typed fields plus a grep-friendly message
("Illegal compliance status transition: compliant → rejected"). The
action layer catches it specifically and surfaces the message as the
typed ActionResult error string.

**Tests (`lib/companies/__tests__/state-machine.test.ts`, +83).**

- 13 per-pair "legal pair" tests, one for every ✓ in the table.
- 36 cross-product cells of the full `from × to` matrix — catches
  accidental ✓-openings AND ✓-closures.
- `assertTransitionCompliance` non-throw assertions on every legal
  pair (mirror of the legal tests, against the throwing helper).
- Illegal-target batched assertion tests, one per `from` state, that
  every illegal target throws.
- An assertion-error inspection test that walks
  `err.from` / `err.to` / `err.message` to pin the error shape.
- Terminal-state pin: `COMPLIANCE_STATUS_TRANSITIONS.rejected.size ===
  0` plus one outbound-throw test per non-rejected target.
- Reversibility pin: `compliant ↔ suspended` both directions legal.
- Same-state no-op tests per status.

This Chunk-1 budget (~12) overran significantly — 83 tests landed
because the per-cell cross-product is genuinely useful as a precise
contract pin and runs in ~6ms.

### Chunk 2 — `updateCompany` wiring + audit verb (commit `49fb14f`)

**`updateCompany` (action).**

Inside the staff/admin patch-building block:

```ts
let complianceMoved = false;
if (isStaffOrAdmin) {
  if (input.complianceStatus !== undefined) {
    if (input.complianceStatus !== existing.complianceStatus) {
      try {
        assertTransitionCompliance(
          existing.complianceStatus,
          input.complianceStatus,
        );
      } catch (err) {
        if (err instanceof ComplianceTransitionError) {
          return {
            ok: false,
            field: "complianceStatus",
            error: err.message,
          };
        }
        throw err;
      }
      complianceMoved = true;
    }
    patch.complianceStatus = input.complianceStatus;
  }
  // ...internalNotes, rejectionReason as before
}
```

The transition check fires only on an actual status difference (not a
no-op same-status patch), so the audit-verb fork is binary: either a
real state move (`complianceMoved=true`) emits
`compliance_status_changed`, or anything else stays on plain `updated`.

**Audit verb routing.**

```ts
await recordAuditEvent({
  ...,
  action: complianceMoved ? "compliance_status_changed" : "updated",
  ...
});
```

The `compliance_status_changed` verb has been in the `AuditAction`
union since Day 6 but nothing emitted it. Now it fires exclusively on
legitimate state moves. Before/after snapshots are the same shape
as the plain `updated` case — partial dict of touched fields — so any
existing audit reader that walks `before` / `after` keeps working
without change. On a move into `rejected`, the snapshot covers both
`complianceStatus` and `rejectionReason`.

**Schema superRefine (`updateCompanySchema`).**

```ts
if (data.complianceStatus === "rejected") {
  const reason = data.rejectionReason;
  const trimmed = typeof reason === "string" ? reason.trim() : reason;
  if (trimmed === undefined || trimmed === null || trimmed === "") {
    ctx.addIssue({
      code: "custom",
      path: ["rejectionReason"],
      message: "A rejection reason is required when moving a company to rejected",
    });
  }
}
```

Catches a patch that flips status to `rejected` with no / empty /
whitespace-only reason. The inverse direction (clearing the reason
when moving AWAY from rejected) stays permitted — only the
`rejected ⇒ non-null reason` half is enforced, matching the
seed-invariant verifier's contract.

**Tests (`lib/companies/__tests__/actions.test.ts`, +9 new file).**

The prompt assumed an existing `actions.test.ts` to extend; there
wasn't one in the companies module yet — a clean-slate file landed
covering only the new Day-23 surface (not full re-coverage of the
existing action). Tests cover:

- Illegal `compliant → pending` returns `ok:false`, `field=
  complianceStatus`, row unchanged, no `compliance_status_changed`
  audit row written.
- Terminal `rejected → compliant` returns `ok:false`, row stays
  rejected with `rejectionReason` preserved.
- Legal `pending → compliant` succeeds, row moves, audit verb is
  `compliance_status_changed`, before/after snapshots correct.
- Same-status no-op update does NOT emit `compliance_status_changed`
  (the verb routing is binary on real movement).
- Pure non-status update (e.g. rename) emits plain `updated`.
- Schema-layer `rejected` without reason fails at the schema with
  `field=rejectionReason`; whitespace-only reason fails too.
- Schema-layer `rejected` with populated reason succeeds, row carries
  the reason, audit `after` includes it.
- Company-role caller has `complianceStatus` silently dropped; the
  state-machine path isn't reached; audit verb stays `updated`.

### Chunk 3 — Integration tests for the seed-driven path (commit `04d8644`)

**Why a separate test file.** Chunk-2's tests cover the action surface
at unit-test granularity. Chunk 3 frames the contract as it'd play out
on the real dataset: the seed populates `rejected` and `suspended`
companies via direct INSERT and the state-machine path is never hit
unless a real transition happens via the action.

**Tests
(`lib/companies/__tests__/state-transitions-integration.test.ts`, +8).**

Fixture seeds one company per starting status (pending / compliant /
suspended / rejected — rejected with a populated reason same as the
seed does), each via direct INSERT. The tests then exercise real
`updateCompany` calls:

- **pending → compliant** moves the row, audit verb is
  `compliance_status_changed`, before/after snapshots correct.
- **compliant → pending** returns `ok:false`, row unchanged, no audit
  row written under the new verb.
- **rejected → {pending, compliant, non_compliant, expired, suspended}**:
  5 sub-tests, every outbound transition refused, row stays rejected,
  `rejectionReason` preserved.
- **suspended → compliant** moves the row, audit verb is
  `compliance_status_changed` AND there's no concurrent plain
  `updated` row (the verb routing is exclusive).

### Chunk 4 — `rejectionReason` callout (commit `4ed0ccf`)

**`stripAdminOnlyFields` lifted to its own module.**

A new `lib/companies/field-strip.ts` (non-"use server" sibling of
`actions.ts`) houses the helper. The split is necessary because
`actions.ts` carries `"use server"` and Next.js forbids non-async
exports from such files. The helper now nulls BOTH `internalNotes` AND
`rejectionReason` for company-role callers — extending the existing
internalNotes scoping pattern to the new column. Both `getCompany` and
`listCompanies` route their result rows through this helper.

**Company header callout.**

`app/dashboard/companies/[id]/_components/company-header.tsx` picks up
a new `viewerRole: UserRole` prop. When the viewer is admin / staff
AND the company is `rejected` AND `rejectionReason` is non-empty, a
destructive-tinted `<Alert>` renders below the title strip:

```tsx
{showRejectionCallout && (
  <Alert variant="destructive">
    <Ban aria-hidden />
    <AlertTitle>Rejection reason</AlertTitle>
    <AlertDescription>{company.rejectionReason}</AlertDescription>
  </Alert>
)}
```

The existing `<Alert>` primitive (`components/ui/alert.tsx`) already
ships the destructive variant from shadcn — no new component needed.
The `Ban` icon is the same one the Day-22 Chunk-1 added to the
Rejected badge, keeping the visual language consistent.

The page header wrapper layout changed slightly: the title-row +
button-row now sit inside a nested flex container, and the callout
renders below as a sibling — same visual position as before for the
non-rejected case (zero layout shift), only adding a third row when
the callout fires.

**Tests (`lib/companies/__tests__/field-strip.test.ts`, +5).**

A pure unit test on `stripAdminOnlyFields`:

- Company-role caller: both `internalNotes` AND `rejectionReason`
  null in the returned row.
- Company-role caller: rest of the row passes through unchanged
  (spot-check on id, name, complianceStatus, sector, geography).
- Company-role caller: input row is not mutated.
- Admin caller: `rejectionReason` and `internalNotes` pass through
  intact.
- Staff caller: same — both pass through.

A UI presence test would require a render harness the project doesn't
have today. The field-strip test pins the contract that the callout
depends on; the callout logic itself is a single `&&` chain in the
header component and is best verified by Mayuresh's manual pass.

## Key decisions

**State-machine same-state behaviour is "legal no-op", not "illegal".**
The projects state machine (`lib/projects/state-machine.ts`) treats
`from === to` as a separate code path that callers short-circuit on,
and `isLegalProjectTransition(s, s)` returns `false`. The compliance
helper here goes the other way: `canTransitionCompliance(s, s) ===
true` and `assertTransitionCompliance(s, s)` does not throw. Reason:
in `updateCompany` the natural code-path is "if the field was supplied
AND it differs from existing, then assert". Making same-state legal
collapses the if-chain to a single guard. The action layer separately
checks `input.complianceStatus !== existing.complianceStatus` before
emitting the audit verb, so a same-state patch doesn't pollute the
audit log with a spurious `compliance_status_changed` row.

**Schema-layer `rejected ⇒ rejectionReason` instead of action-layer.**
The Day-23 prompt suggested putting the pair-validation in the
superRefine. The alternative was to validate inside `updateCompany`
after the row-load step. Schema-layer wins because (a) the schema
already runs cross-field checks via superRefine for the JV invariant —
this is the same pattern, (b) catching it at the schema means the
error has a typed `path: ["rejectionReason"]` that Zod surfaces as
`field`, matching the rest of the ActionResult shape, and (c) the seed
verifier checks the row-state invariant separately, so the schema and
verifier together cover "any path that lands a rejected row must have
a reason".

**State-machine assertion BEFORE staging the patch.** The check fires
before any DB write. Logging on illegal-transition success is logged
at INFO (not WARN/ERROR) — it's a legitimate user-facing rejection,
not a system anomaly. Same posture as the unique-conflict translation
already in the file.

**`compliance_status_changed` verb routing is binary on real
movement.** A patch with `complianceStatus: "compliant"` applied to a
row already at `compliant` does NOT emit the new verb — that's a
no-op edit, recorded (if at all) under plain `updated`. The two-line
guard `complianceMoved = (input.complianceStatus !== existing.complianceStatus)`
is the entire contract. Reader UIs can rely on every
`compliance_status_changed` row representing an actual state shift.

**`stripAdminOnlyFields` is its own non-"use server" module.** The
helper has to be importable by a Vitest unit test. Putting it in
`actions.ts` worked at runtime but `actions.ts` is `"use server"`,
which Next.js disallows for non-async exports — the build would fail.
The dedicated file avoids the constraint and gives the test a clean
import path. Same pattern the codebase already uses for
`lib/companies/schemas.ts` and `lib/companies/state-machine.ts` —
non-action code lives in its own file even though it logically
belongs to the companies module.

**Field-strip on `listCompanies` now uses the helper too.** Day 23
added `rejectionReason` to the company-role strip. The list-page query
previously inlined `.map((r) => ({ ...r, internalNotes: null }))` —
that path didn't strip the new field. Routing both `getCompany` and
`listCompanies` through the same helper makes the contract enforceable
in one place and surfaced via the new unit test.

**Callout uses the existing `<Alert variant="destructive">` primitive,
not a hand-rolled div.** The prompt allowed a fallback to a
`bg-destructive/10 border-destructive/20 text-destructive` div if no
Alert primitive existed. It does — `components/ui/alert.tsx` ships
the destructive variant from shadcn. Reusing the primitive keeps the
visual language consistent with any other destructive alert on the
dashboard (none today, but the pattern is now established).

**`Ban` icon reuses the Day-22 Rejected-badge icon.** The badge picks
`Ban` from `lucide-react`; reusing it on the callout keeps the visual
association between "this company is rejected" (badge) and "here's why"
(callout) tight. No new icon import elsewhere — the badge import is
already in `_components/badges.tsx`, the callout import is new in
`_components/company-header.tsx`.

**No new audit row for the callout itself.** The callout is a read
view of an existing column populated alongside the state move. The
audit row already exists from the original move (the
`compliance_status_changed` event with `after.rejectionReason`); the
UI is just a renderer.

## Gotchas surfaced

**`actions.ts` is `"use server"` — non-async exports are a build-time
error.** Originally placed `stripAdminOnlyFields` inside `actions.ts`
as a `function` export. The TypeScript check passed (the directive is
runtime-enforced by Next.js, not by `tsc`), but `pnpm build` would
have caught it. Moved the helper to its own file
(`lib/companies/field-strip.ts`) before running the build. Worth
remembering for any future helper that needs to be importable by a
test — keep it out of `actions.ts`.

**The audit `compliance_status_changed` verb was already in
`AuditAction`.** Day 6 added it to the union but nothing emitted it.
This made `git grep "compliance_status_changed"` produce only the
type-definition site — initially mistook this for "I need to add it
to the union too". Walked the read path
(`lib/audit/schemas.ts::auditActionSchema`) to confirm the verb is
runtime-validated by Zod as well, then the wiring was a one-line
ternary in the existing `recordAuditEvent` call.

**The action-layer no-op skip is what keeps the audit verb tight.**
A same-status patch (e.g. `complianceStatus: "compliant"` against a
compliant row) still stages the patch into the dict — the value did
arrive in the input. Without the `complianceMoved` guard, the audit
verb routing would fire `compliance_status_changed` on a no-op, which
is exactly the pollution the verb was added to avoid. The guard is
load-bearing.

**Whitespace-only reason check uses `.trim()` length 0, not just
strict equality.** A reason of `"   "` would pass `reason !== ""`
trivially. The Zod transform `z.string().trim()` does trim before
validating but the field is optional+nullable, so the trim only fires
when a non-null string is supplied. The superRefine has to re-do the
trim to catch the whitespace-only case — same belt-and-braces pattern
already in `trimmedNameSchema` further up the file.

**`pnpm build` is the right verifier for a "use server" check.** The
TypeScript type-check passed cleanly with the wrong-shape helper in
`actions.ts`; only the Next.js build catches the
non-async-export-in-"use server" rule. Worth carrying as a rule of
thumb: if any `actions.ts` is touched, run the build, not just
`tsc --noEmit`.

**`pnpm test --run` reports 592 not the prompt's 500-510 estimate.**
Chunk 1 overshot the budgeted ~12 tests because the full
cross-product is genuinely useful as a contract pin — 36 cells, plus
the legal/illegal sub-batches, plus assertion-side mirrors, plus the
terminal-state pin, plus reversibility / same-state tests. Total: 83
in Chunk 1 alone, on top of 9 (Chunk 2) + 8 (Chunk 3) + 5 (Chunk 4).
Each test runs in microseconds; full companies suite is 105 tests in
<600ms.

## Surfaces touched

```
# Chunk 1 — State-machine module + tests (commit 4bb81dd)
lib/companies/state-machine.ts                                    (new)
lib/companies/__tests__/state-machine.test.ts                     (new — 83 tests)

# Chunk 2 — updateCompany wiring + audit verb (commit 49fb14f)
lib/companies/actions.ts                                          (modified — state-machine call + verb routing)
lib/companies/schemas.ts                                          (modified — superRefine: rejected ⇒ reason)
lib/companies/__tests__/actions.test.ts                           (new — 9 tests)

# Chunk 3 — Integration tests (commit 04d8644)
lib/companies/__tests__/state-transitions-integration.test.ts     (new — 8 tests)

# Chunk 4 — UI callout + field strip (commit 4ed0ccf)
app/dashboard/companies/[id]/_components/company-header.tsx       (modified — +callout + viewerRole prop)
app/dashboard/companies/[id]/page.tsx                             (modified — pass viewerRole)
lib/companies/actions.ts                                          (modified — wire stripAdminOnlyFields into both reads)
lib/companies/field-strip.ts                                      (new — extracted helper)
lib/companies/__tests__/field-strip.test.ts                       (new — 5 tests)

# Day 23 report (this commit)
docs/reports/day-23-report.md                                     (new)
```

## Test totals

Before this session: **487 tests across 32 files**, all green (Day 22
end state).

After this session: **592 tests across 33 files**, all green every
run. Net: **+105** across four new test files.

Breakdown:

- +83: `lib/companies/__tests__/state-machine.test.ts` (Chunk 1 — full
  cross-product matrix + assertion-side mirrors + terminal-state /
  reversibility / same-state pins).
- +9:  `lib/companies/__tests__/actions.test.ts` (Chunk 2 — action
  surface).
- +8:  `lib/companies/__tests__/state-transitions-integration.test.ts`
  (Chunk 3 — seed-driven integration).
- +5:  `lib/companies/__tests__/field-strip.test.ts` (Chunk 4 — pure
  unit on the field-strip contract).

The session-opening prompt budgeted ~13-23 new tests. Landed at +105
because Chunk 1's cross-product matrix is precise contract pinning and
runs in microseconds — cheap insurance against future drift in the
transitions table.

## Followups for Day 24+

**From this session:**

1. **Admin-side form for setting `rejectionReason` interactively.**
   The seed populates rejected rows directly; the new schema +
   state-machine code accepts a patch carrying both fields, but the
   actual edit form (`app/dashboard/companies/[id]/edit/_components/company-form.tsx`
   or equivalent) doesn't surface a `rejectionReason` input today. A
   thin UI pass adds the field, conditionally rendered when
   `complianceStatus === "rejected"` in the form, with the schema's
   superRefine catching the empty-reason case at submission time.
2. **Compliance state-transition history widget.** The audit log now
   has a dedicated `compliance_status_changed` verb. A small "state
   timeline" widget on the company detail page (admin/staff only)
   would render the move history without the user having to scroll the
   generic activity feed.
3. **Resend email on state change.** A move into `rejected` is a
   high-value event for the company. Once the Resend domain is
   verified (separate deployment-session followup), a transactional
   email to the company's `contactEmail` carrying the rejection reason
   would close the loop. Currently the company learns about the state
   move only by logging in.
4. **Per-status transition buttons in the UI.** Today the only path
   to a state change is the generic edit form. A "transition" action
   panel — like the `transitionProjectStatus` UI on the project detail
   page — would render only the legal next statuses
   (`legalNextStatuses`-style helper would land in the state-machine
   module first), each as a button with optional reason input. Cleaner
   UX than the catch-all edit form for a single-field update.
5. **Bulk-transition action for admins.** The Day-22 followup #1
   originally asked for this — the embedded prompt explicitly punted.
   Now that the per-row state-machine guard exists, a small bulk
   wrapper that validates every row's transition and atomically
   applies the set is a small addition. Useful for cases like "move
   every pending company that's been pending more than 60 days to
   non_compliant".
6. **Test-file naming convention drift.** Chunks 2 and 3 split the
   action-layer tests across two files (`actions.test.ts` and
   `state-transitions-integration.test.ts`). The split is deliberate
   per the prompt, but a future contributor coming cold may wonder why
   `actions.test.ts` doesn't cover everything. Worth a short comment
   at the top of `actions.test.ts` explaining the split — or a
   one-time merge once the surface settles.

**Carried forward from Day 22 (unchanged):**

7. Realistic Indian-flavoured fixture data (Day-21 followup #2).
8. Real R2 fixture files (Day-21 followup #3).
9. Multi-step registration UX / CAPTCHA / rate limiting (Day-15
   carry-forward).
10. Charts on the dashboard + report (Day-21 followup).
11. Period-over-period comparison on the reports.
12. Real Consultway logo on the PDF cover.
13. Streaming exports beyond 1000 rows.
14. Searchable typeahead selects on forms + reports pickers.
15. Per-document CSV export / Bulk CSV import / Saved-report-config
    persistence / Dashboard widget loading skeletons / deleteProject /
    Project-attached documents / Side-by-side detail view /
    TransactionType etc. badge palette unification / session
    invalidation on password reset / public tender browsing /
    OpenNext install / D1 client factory / Resend domain verification
    / Real Cloudflare bucket UUIDs / Hoist escapeHtml.

**Already-resolved this session:**

- **Day-22 followup #1** (compliance state-machine guards): landed in
  Chunks 1-3.
- **Day-22 followup #3** (`rejectionReason` field surfaced on the
  detail page): landed in Chunk 4.
- **Day-22 followup #4** (`compliance_status_changed` audit verb
  routing): landed in Chunk 2 — `updateCompany` now writes the verb
  on legitimate state moves; the seed still writes plain `created` for
  newly-inserted rejected/suspended companies (which is correct —
  they're inserts, not transitions).

**Still deferred from Day 22:**

- Day-22 followup #2 (badge-palette design pass aligning with the
  Figma palette) — a design-time UX session, not an engineering one.

## Carry-forward to Day 24

- **`dev` ends at 4 commits past `origin/dev`** before this report's
  own commit: `4bb81dd` / `49fb14f` / `04d8644` / `4ed0ccf`. The Day-23
  report commit makes it 5. Pushing still requires explicit approval
  per `<permissions>`.
- **592 tests passing on every run.** Four new test files added under
  `lib/companies/__tests__/`; no existing test files modified.
- **Schema unchanged from Day 22 (migration 0013).** Day 23 did not
  generate a migration — the column + widened union were already in.
- **Zero new dependencies** this session.
- **`pnpm db:seed`** continues to land every row as `unchanged` against
  the existing dev DB.
- **`pnpm seed:verify`** clean.
- **`pnpm cron:*`** all unchanged — Day 23 didn't touch crons.
- **`compliance_status_changed` audit verb is now live** — only emits
  on real state moves via `updateCompany`. The seed never emits it
  (seeded rejected/suspended rows are inserts, not transitions); future
  bulk-transition tooling would emit it per affected row.
- **`COMPLIANCE_STATUS_TRANSITIONS` is the source of truth** for what
  moves are legal. Any future "transition" UI button should consult it
  via a `legalNextStatuses`-style helper (not yet added; lands when a
  per-state action panel is built — see followup #4).
- **`stripAdminOnlyFields` is in `lib/companies/field-strip.ts`** —
  any future admin-only column on `companies` should be added here so
  the strip covers it everywhere. Two columns covered today:
  `internalNotes` and `rejectionReason`.
- **Manual browser pass on the rejection callout deferred to
  Mayuresh.** The `pnpm build` was clean, but visual confirmation —
  callout shows for admin/staff on a rejected company; absent for
  company-role; absent when `rejectionReason` is null — needs a real
  browser. Any visual issue lands as a Day-24 followup.

That's Day 23.
