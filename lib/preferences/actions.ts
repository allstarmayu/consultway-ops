/**
 * User-preferences module — Server Actions.
 *
 * Two actions:
 *   - `getPreferences()` — read the current user's row, returning hard-
 *     coded defaults if no row exists yet. Always succeeds for signed-in
 *     callers; unauthenticated callers get `{ ok: false }`.
 *   - `updatePreferences(patch)` — partial update. Lazily inserts a row
 *     on first call; subsequent calls UPDATE the row. Validates against
 *     `updatePreferencesSchema` (theme id resolved against the live
 *     catalog).
 *
 * Authorisation: every signed-in user can read + write their OWN row.
 * There's no cross-user write here — a user can't change someone else's
 * preferences. Admin / staff don't get a special path; if they need to
 * inspect another user's prefs later we'll add a `getPreferencesById`
 * with role-gated access.
 *
 * Audit logging: deliberately NOT wired. These are personal display
 * preferences with no security or business consequence — auditing every
 * theme switch would drown the real signal in noise.
 *
 * The actions return the full preferences row on success so the caller
 * (settings page on next render, or the sidebar theme picker) can apply
 * the new state immediately without a re-fetch round-trip.
 *
 * @module lib/preferences/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userPreferences, type UserPreferences } from "@/lib/db/schema";
import { assertUserExists, readSession } from "@/lib/auth/session";
import { STALE_SESSION_ERROR } from "@/lib/auth/stale-session";
import { logger } from "@/lib/logger";
import { DEFAULT_THEME } from "@/lib/themes";
import type { ActionResult } from "@/lib/types/action-result";
import {
  updatePreferencesSchema,
  type UpdatePreferencesInput,
} from "./schemas";

const log = logger.child({ module: "preferences-actions" });

// ── Defaults ────────────────────────────────────────────────────────────────

/**
 * Mirrors the DB column defaults exactly. Returned by `getPreferences`
 * when no row exists yet so callers always get a populated object.
 *
 * Keep in lockstep with the column `.default(...)` calls in
 * `lib/db/schema.ts::userPreferences`. The duplication is acceptable —
 * the alternative (an extra round-trip just to read the defaults) costs
 * more than the maintenance burden.
 */
function buildDefaults(userId: string): UserPreferences {
  const now = new Date().toISOString();
  return {
    userId,
    themeId: DEFAULT_THEME,
    density: "comfortable",
    reducedMotion: false,
    weeklyDigest: true,
    monthlyReport: false,
    documentExpiry: true,
    tenderAlerts: true,
    assignmentAlerts: true,
    incidentAlerts: true,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Fetch the current user's preferences, falling back to defaults if no
 * row exists. Never throws for the missing-row case — that's the
 * lazy-creation contract.
 */
export async function getPreferences(): Promise<
  ActionResult<{ preferences: UserPreferences }>
> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // Defend against a stale session JWT (user row was deleted, or DB was
  // reseeded after the cookie was issued). Bouncing here means the
  // Settings page's load fails cleanly and the layout redirects to login
  // instead of rendering a half-broken settings shell that will FK-fault
  // on the first save.
  if (!(await assertUserExists(session.userId))) {
    log.warn("stale session — user no longer exists", {
      userId: session.userId,
    });
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.userId))
    .limit(1);

  return {
    ok: true,
    preferences: row ?? buildDefaults(session.userId),
  };
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Apply a patch to the current user's preferences. Upserts:
 *   - First call inserts a fresh row from defaults + the patch.
 *   - Subsequent calls UPDATE the row in place.
 *
 * Empty patch (after validation strips unknown keys) short-circuits to
 * the current row — no DB write, no toast-worthy state change.
 */
export async function updatePreferences(
  rawInput: UpdatePreferencesInput,
): Promise<ActionResult<{ preferences: UserPreferences }>> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // Same stale-session guard as getPreferences — without this the insert
  // path below crashes with a SQLITE_CONSTRAINT_FOREIGNKEY when the
  // session JWT points at a user row that no longer exists.
  if (!(await assertUserExists(session.userId))) {
    log.warn("stale session — user no longer exists", {
      userId: session.userId,
    });
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const parsed = updatePreferencesSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Invalid input",
      field: issue?.path[0]?.toString(),
    };
  }

  const patch = parsed.data;
  const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;
  const patchKeysWithValues = patchKeys.filter(
    (k) => patch[k] !== undefined,
  );

  // Load the existing row (if any) so we can short-circuit no-ops and
  // return the merged shape to the caller without a follow-up read.
  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.userId))
    .limit(1);

  if (patchKeysWithValues.length === 0) {
    return {
      ok: true,
      preferences: existing ?? buildDefaults(session.userId),
    };
  }

  if (!existing) {
    // First save for this user — insert a fresh row from defaults + the patch.
    const defaults = buildDefaults(session.userId);
    const insertRow = { ...defaults, ...patch };
    await db.insert(userPreferences).values(insertRow);
    log.info("user preferences row created", {
      userId: session.userId,
      changedKeys: patchKeysWithValues,
    });
    return { ok: true, preferences: insertRow };
  }

  // Existing row — UPDATE in place. Drizzle's $onUpdate hook bumps
  // updatedAt automatically.
  await db
    .update(userPreferences)
    .set(patch)
    .where(eq(userPreferences.userId, session.userId));

  log.info("user preferences updated", {
    userId: session.userId,
    changedKeys: patchKeysWithValues,
  });

  // Return the merged shape. We don't re-read from the DB because the
  // patch is authoritative for the columns it touched, and the
  // unchanged columns are still in `existing`.
  return {
    ok: true,
    preferences: {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    },
  };
}
