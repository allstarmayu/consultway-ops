/**
 * User-profile module — Server Actions.
 *
 * Single action this round: `updateProfile({ name })`. Writes through
 * to `users.name` for the signed-in caller, emits an audit event, and
 * returns the new value so the caller can hydrate its local form
 * state without a re-fetch.
 *
 * Authorisation: every signed-in user can update their OWN name.
 * Phone / email / jobTitle are deliberately not in scope this round:
 *   - phone needs a schema migration (no `phone` column on `users`)
 *   - email change needs a verification flow (verify-old + verify-new)
 *   - jobTitle is purely display, no use case for persistence yet
 *
 * Stale-session handling mirrors `lib/preferences/actions.ts` — the
 * shared `assertUserExists` helper guards against a JWT outliving the
 * row it points at. Without it, the UPDATE silently affects 0 rows
 * and the UI thinks the save succeeded when it didn't.
 *
 * Audit logging: ON. Name is identity-adjacent data — admins should
 * be able to answer "who changed this user's display name and when?"
 * during an incident. The before/after snapshots capture only the
 * single field touched, not the whole user row.
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
 * Update the signed-in user's display name.
 *
 * Returns the new name on success so the caller's form state can
 * advance without a follow-up `getProfile` round-trip.
 *
 * Side effects on success:
 *   - One UPDATE on `users` (name + updatedAt via $onUpdate hook).
 *   - One audit-log row: action=updated, targetType=user, targetId=userId,
 *     before/after snapshots scoped to the name column only.
 *
 * @param rawInput The partial profile patch. Validated against
 *                 `updateProfileSchema`; unknown keys are rejected.
 * @returns ActionResult with the new name on success.
 */
export async function updateProfile(
  rawInput: UpdateProfileInput,
): Promise<ActionResult<{ name: string }>> {
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

  // Read the existing name so the audit log can capture a real
  // before/after diff. Drizzle's $onUpdate handles updatedAt — no
  // explicit timestamp in the SET payload.
  const [existing] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  // No-op short-circuit — the user submitted the same name. Skip the
  // write + audit so the trail doesn't fill with "changed name from
  // Foo to Foo" rows when the user clicks Save on an unchanged form.
  if (existing && existing.name === patch.name) {
    return { ok: true, name: patch.name };
  }

  await db
    .update(users)
    .set({ name: patch.name })
    .where(eq(users.id, session.userId));

  log.info("profile name updated", {
    userId: session.userId,
    nameLength: patch.name.length,
  });

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
    before: existing ? { name: existing.name } : undefined,
    after: { name: patch.name },
  });

  return { ok: true, name: patch.name };
}
