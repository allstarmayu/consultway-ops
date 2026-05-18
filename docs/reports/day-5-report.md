# Day 5 — Reversal capability

_Date: 2026-05-18_

## Scope

Make every tender and application status change reversible. Before
Day 5, the tender state machine was strictly left-to-right and
application decisions were one-way once staff clicked Shortlist or
Reject. Misclicks were unrecoverable except by creating a fresh draft
(losing the audit trail and forcing re-applications). Day 5 closes
that gap.

The work shipped across three commits, each independently testable
and tsc-clean:

```
636d09d  feat(tenders): wire reversal UI for admins and applicants (Chunk 3)
df01a2a  feat(tenders): add four reversal server actions (Chunk 2)
90620ab  feat(tenders): relax state machine and add reversal schemas (Chunk 1)
```

A bonus fix landed at the end of the day for `scripts/snapshot.ps1`
after the session surfaced a silent bug — see _Bonus_ below.

## What shipped

### Four new Server Actions in `lib/tenders/actions.ts`

| Action | Caller | Reason | Transition |
|---|---|---|---|
| `reopenTender` | admin only | optional | `closed` → `published` |
| `retractAward` | admin only | **required** (≥5 chars) | `awarded` → `closed` |
| `reinstateApplication` | admin/staff | optional | `shortlisted` or `rejected` → `submitted`, `decidedAt` cleared |
| `recallApplication` | company role on own row | optional | `withdrawn` → `submitted`, within 7-day window + while tender is still accepting applications |

Each action gets its own dedicated audit verb
(`tender_reopened`, `tender_award_retracted`,
`application_reinstated`, `application_recalled`) so the audit log
distinguishes reversals from the original transition. The captured
reason and forensic context (e.g. `daysSinceWithdrawal`,
`previousDecidedAt`) ride in the audit event's `metadata` field.

### State machine updates in `lib/tenders/state-machine.ts`

- Tender machine: legalised `closed → published` and `awarded → closed`.
  All other transitions are unchanged.
- New application-side machine (`LEGAL_APPLICATION_TRANSITIONS`):
  codifies that `shortlisted`/`rejected` may return to `submitted`,
  and `withdrawn` may return to `submitted`. Includes
  `isLegalApplicationTransition` and `illegalApplicationTransitionMessage`
  helpers mirroring the tender-side API.
- New `RECALL_WINDOW_DAYS = 7` constant + `isWithinRecallWindow` and
  `daysSince` helpers. Both parsers accept SQLite space-separated and
  JS T-separated ISO timestamps, and **fail closed on malformed input
  (return `null` rather than throwing)** — defensive against the
  timestamp format inconsistency carried forward from Day 3.

### Reason capture on `ConfirmDialog`

Backwards-compatible extension. New optional props:
`reasonField?: "optional" | "required"`, `reasonLabel`,
`reasonPlaceholder`, `reasonHint`. The `onConfirm` signature widened
to `(reason?: string) => void | Promise<void>`. A
`REQUIRED_REASON_MIN_LENGTH = 5` constant kept in lockstep with the
schema's minimum. Existing callers (delete confirmations,
`markAwarded` etc.) untouched.

### UI surfaces on the tender detail page

- **`tender-header.tsx`** — Reopen button (admin, `closed` status) and
  Retract award button (admin, `awarded` status). Both wired to the
  new `ConfirmDialog` reason capture; Retract award uses
  `confirmVariant="destructive"` and bordered-destructive styling to
  signal the higher-stakes action.
- **`applications-table.tsx`** — Inline Reinstate icon button
  (RotateCcw) on rows with `status === "shortlisted"` or `"rejected"`,
  replacing the Shortlist/Reject icon pair. Withdrawn rows show no
  staff actions; recalling them is the company's path.
- **`apply-button.tsx`** — Recall button appears on the user's own
  `withdrawn` application **when both** the recall window is open
  **and** the tender still accepts applications. A live caption shows
  "N days left to recall" / "Last day to recall" / "Recall window has
  passed" / "Cannot recall — tender is closed" depending on state.
  The Withdraw copy was softened in the same touch (previously "Once
  withdrawn, you cannot re-apply to this tender" was a half-truth
  once recall existed).

### Audit verbs in `lib/audit/log.ts`

Added four entries to the `AuditAction` union:
`tender_reopened`, `tender_award_retracted`, `application_reinstated`,
`application_recalled`. The `recordAuditEvent` body itself is
unchanged — still the log-line stub. The DB-backed audit_log table
swap is the body of `log.ts`, not the call sites, and is a Day 6+
candidate.

## Key decisions

**Reopen and Retract are admin-only, not staff.** Mirrors the
`deleteTender` gate. Staff who needs a reversal escalates to an
admin. Keeps the blast radius small for two actions that visibly
contradict prior decisions (publishing a tender Acme already saw as
"closed"; retracting a procurement decision with contractual
implications).

**Required reason on Retract only.** Reopen, Reinstate, and Recall
all take an optional reason — most reversals are routine corrections.
Retract award is the one reversal where a written rationale matters
enough to gate the action on it.

**Reinstate clears `decidedAt` to NULL.** A non-null `decidedAt` on a
`submitted` row would be a data anomaly any future "when was this
decided?" query would have to special-case. The original
`decidedAt` is preserved in the audit event's
`metadata.previousDecidedAt` so forensic reconstruction is possible.
Same applies to Recall.

**7-day recall window, hard-coded constant.** Long enough for a
Monday-morning regret to be actioned, short enough that stale
withdrawals don't reappear weeks later and surprise staff. The
constant is named `RECALL_WINDOW_DAYS` and lives in `state-machine.ts`
— one edit point if business preference shifts.

**Recall also gates on tender status.** A withdrawn application
within the 7-day window still cannot recall if the tender has
moved on to `closed` or `awarded`. Bringing a row back to
`submitted` on a non-published tender would leave it in a state the
rest of the system cannot reason about (e.g. the Apply gate
considers the company "already applied" and refuses re-application).

**Delete intentionally not reversed.** Delete already has two safety
nets (type-to-confirm + draft-only restriction); soft-delete is a
larger surface area and a separate design conversation. Deferred to
the future audit-log/data-retention session.

## Defensive bits worth remembering

- `recallApplication` does **two** state-machine checks (status
  equality first, then `isLegalApplicationTransition`) — the first
  surfaces a clear "not withdrawn" message; the second guards against
  any future tightening of the application state machine.
- `reinstateApplication` refuses `withdrawn` explicitly before
  consulting the state machine — the machine would technically allow
  the transition, but reinstate is the staff-decision-reversal
  surface, not the company-driven path. Keeps the two action
  surfaces distinct.
- The `apply-button` recall caption guards against `daysSince`
  returning `null` (malformed timestamp). Without the guard, the
  caption would render "NaN days left" — the type checker caught
  this before it shipped.

## Tech debt carried forward

Nothing new added this session. Pre-existing items still open:

- **Timestamp format inconsistency** (Day 3) — SQLite
  `datetime('now')` produces space-separated, JS `toISOString()`
  produces T-separated. `state-machine.ts` parsers normalise both,
  but the underlying inconsistency is still in the DB. A schema-side
  fix would require a migration.
- **`audit_log` table** — still a log-line stub. Day 6+ swap.
- **`companies.annualTurnover`** column — still missing; the
  `applyToTender` turnover gate is still stubbed with a `TODO` marker.
- **`listTenders` company-role draft visibility** — still uses a JS
  post-filter rather than a SQL `OR` clause. Fine at Phase 1 scale.
- **`markAwarded` doesn't capture the winning company** — awaits the
  `awardedCompanyId` column (Phase 2, project-tracking dependency).
- **Edit-page banner copy on closed tenders** — minor; still reads as
  if "only internal notes editable" is the permanent fate, doesn't
  acknowledge Reopen exists.
- **Reinstate dialog's `pending={rowPending}` prop is functionally
  dead code** — the dialog block is unreachable when `rowPending` is
  true because `canReinstateRow` gates it out. Harmless; documents
  intent. Not worth a cleanup commit.

## Bonus — snapshot script fix

After Day 5's reversal work landed, a `pnpm snapshot` run reported
**20 files skipped** with reason "not present" for files that were
visibly on disk (every `[id]/*` route, plus `lib/tenders/actions.ts`
which had grown past the 50 KB per-file cap). Root cause:
PowerShell's `Test-Path`, `Get-Item`, and `Get-Content` interpret
square brackets in paths as glob character classes by default, so
`Test-Path "app\dashboard\tenders\[id]\page.tsx"` was returning
`$false` and the script silently dropped the file. This had been
true since the snapshot script was written; it surfaced now because
Day 5 made everyone look at the snapshot output carefully.

Patched in a separate commit:

- Every `Test-Path`, `Get-Item`, `Get-Content`, `Set-Content`
  consuming an absolute path now uses `-LiteralPath`.
- Size budgets removed at owner's preference; the previous 50 KB
  per-file and 500 KB total caps had added a separate failure mode
  on top of the bracket bug. Hard exclusion lists for
  `node_modules`, binary extensions, and `pnpm-lock.yaml` remain —
  those are signal filters, not size filters.
- A `## Snapshot Health` table now renders near the top of
  `project-snapshot.md` so future regressions surface in one glance
  rather than buried at the bottom.
- Console warns loudly if any file reports "not present", with a
  pointer to the manifest.

Post-fix metrics: 96 files dumped (was 77), 1 skipped
(`middleware.ts`, which is genuinely absent — a Day 6 candidate),
663 KB output.

## What's next

Day 6 entry points, in order of recommended priority:

1. **`middleware.ts` + persistent `audit_log` table** — clears the
   sole remaining "not present" snapshot warning and closes one of
   the longest-standing pieces of debt (the audit-log stub has been
   in place since Day 2).
2. **`companies.annualTurnover` column** — small migration; unlocks
   the deferred turnover gate in `applyToTender`.
3. **Documents module** — next major launchpad capability per the
   project brief. Schema + R2 uploads + expiry reminders, likely
   3–4 sessions of its own.
4. **Self-serve company registration** — opens the public `/register`
   flow and the admin approval queue. Pairs naturally with the
   documents module (documents are required on registration).

Estimate against the full Proposal-B scope: **~27 sessions
remaining** to ship the entire operations suite (project tracking,
transactions, reports, deployment) with the agreed stack. Launchpad
scope alone (sessions 1–10 of that backlog) is reachable in roughly
**3 weeks** at the current cadence.
