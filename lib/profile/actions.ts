/**
 * User-profile module — Server Actions.
 *
 * Single action this round: `updateProfile({ name, phone?, jobTitle? })`.
 * Writes through to `users.name` / `users.phone` / `users.jobTitle` for
 * the signed-in caller, emits a SCOPED audit event (only the columns
 * that actually changed appear in `before` / `after`), and returns the
 * new values so the caller can hydrate its local form state without a
 * re-fetch.
 *
 * Authorisation: every signed-in user can update their OWN profile.
 *
 * Persisted fields:
 *   - `name`      — required on every call, length-bounded.
 *   - `phone`     — optional, free text, no auth-factor semantics.
 *                   Pass null to clear; empty string is coerced to null.
 *   - `jobTitle`  — optional, free text for display only.
 *
 * Still NOT in scope:
 *   - `email`     — changing the primary identifier needs a verify-old
 *                   + verify-new flow with email tokens. Out of scope
 *                   without explicit approval (security-critical).
 *
 * Stale-session handling mirrors `lib/preferences/actions.ts` — the
 * shared `assertUserExists` helper guards against a JWT outliving the
 * row it points at. Without it, the UPDATE silently affects 0 rows
 * and the UI thinks the save succeeded when it didn't.
 *
 * Audit logging: ON. Profile fields are identity-adjacent data —
 * admins should be able to answer "who changed this user's display
 * name / phone / job title and when?" during an incident. The
 * before/after snapshots capture ONLY the columns that actually
 * changed — saving the same shape doesn't audit, and changing just
 * `phone` doesn't pollute the snapshot with `name` / `jobTitle`.
 *
 * @module lib/profile/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { assertUserExists, readSession } from "@/lib/auth/session";
import { STALE_SESSION_ERROR } from "@/lib/auth/stale-session";
import { recordAuditEvent } from "@/lib/audit/log";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/types/action-result";
import { updateProfileSchema, type UpdateProfileInput } from "./schemas";

const log = logger.child({ module: "profile-actions" });

/**
 * Shape of the returned profile after a successful save. Mirrors the
 * three persisted columns so the caller can drive its local form state
 * without a follow-up `getProfile` round-trip.
 */
export interface UpdatedProfile {
  name: string;
  phone: string | null;
  jobTitle: string | null;
}

/**
 * Coerce a phone / jobTitle field to its stored shape. The schema
 * already trimmed; here we collapse empty strings to null so the DB
 * column and the form's "user cleared the input" gesture agree.
 */
function normaliseOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.length === 0 ? null : value;
}

/**
 * Update the signed-in user's profile (name + optional phone + optional
 * jobTitle).
 *
 * Returns the new persisted shape on success so the caller's form state
 * can advance without a follow-up read.
 *
 * Side effects on success (when at least one field actually changed):
 *   - One UPDATE on `users` setting the changed columns + updatedAt
 *     (via the $onUpdate hook).
 *   - One audit-log row: action=updated, targetType=user, targetId=userId,
 *     before/after snapshots scoped to ONLY the columns that changed.
 *
 * If every submitted field matches what's already in the row, the
 * action short-circuits with `ok: true` and the existing values —
 * no write, no audit. (Avoids "Mayuresh -> Mayuresh" noise in the
 * audit feed when the user clicks Save on an unchanged form.)
 *
 * @param rawInput The profile patch. Validated against
 *                 `updateProfileSchema`; unknown keys are rejected.
 * @returns ActionResult with the new persisted profile on success.
 */
export async function updateProfile(
  rawInput: UpdateProfileInput,
): Promise<ActionResult<UpdatedProfile>> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // Stale-session guard — same shape as preferences. The UPDATE below
  // would silently match 0 rows for a dead userId (no FK fault here
  // since users is the target, not a child), which would falsely
  // report success. Bouncing here surfaces the real state cleanly.
  if (!(await assertUserExists(session.userId))) {
    log.warn("stale session — user no longer exists", {
      userId: session.userId,
    });
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const parsed = updateProfileSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Invalid input",
      field: issue?.path[0]?.toString(),
    };
  }

  const patch = parsed.data;
  const nextPhone = normaliseOptional(patch.phone);
  const nextJobTitle = normaliseOptional(patch.jobTitle);

  // Read the current state so the audit log can capture a scoped diff
  // and so the no-op short-circuit can compare each field.
  const [existing] = await db
    .select({
      name: users.name,
      phone: users.phone,
      jobTitle: users.jobTitle,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  // Belt-and-suspenders. `assertUserExists` already returned true above
  // so this branch shouldn't fire in practice, but if a race deletes
  // the user between the existence check and this read, we don't want
  // to write to a non-existent row.
  if (!existing) {
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  // Compute the per-field diff up-front. The diff drives BOTH the
  // SET payload (only write columns that actually changed) AND the
  // audit before/after (only snapshot columns that actually changed).
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

  // No-op short-circuit — nothing actually changed. Return the
  // existing values so the caller's local form state still advances
  // (the save bar collapses) but skip the write + audit.
  if (Object.keys(changes).length === 0) {
    return {
      ok: true,
      name: existing.name,
      phone: existing.phone,
      jobTitle: existing.jobTitle,
    };
  }

  // Build the SET payload from the diff. Drizzle's $onUpdate handles
  // updatedAt — no explicit timestamp here.
  const setPayload: { name?: string; phone?: string | null; jobTitle?: string | null } = {};
  if (changes.name) setPayload.name = changes.name.after;
  if (changes.phone) setPayload.phone = changes.phone.after;
  if (changes.jobTitle) setPayload.jobTitle = changes.jobTitle.after;

  await db
    .update(users)
    .set(setPayload)
    .where(eq(users.id, session.userId));

  log.info("profile updated", {
    userId: session.userId,
    changedFields: Object.keys(changes),
  });

  // Build the scoped before/after snapshots — only columns that
  // actually changed appear in either. The shape `Record<string,
  // unknown>` is what `recordAuditEvent` expects.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [field, diff] of Object.entries(changes)) {
    before[field] = diff.before;
    after[field] = diff.after;
  }

  // Audit AFTER the write — if the write fails the audit doesn't fire,
  // matching the convention used by every other Server Action in the
  // codebase. `recordAuditEvent` never throws so it can't poison a
  // successful update either way.
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: "updated",
    targetType: "user",
    targetId: session.userId,
    before,
    after,
  });

  return {
    ok: true,
    name: patch.name,
    phone: nextPhone,
    jobTitle: nextJobTitle,
  };
}
