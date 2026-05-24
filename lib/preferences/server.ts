/**
 * SSR-friendly preferences reader.
 *
 * `lib/preferences/actions.ts` is a `"use server"` module — Server
 * Actions only. Server Components (e.g. dashboard layout) calling into
 * `getPreferences()` would work, but they'd pay for the session lookup
 * and stale-session guard *again* on top of whatever the layout already
 * did. This module exposes a thinner read that takes a `userId` the
 * caller already has, skips the session round-trip, and never returns
 * an error — falling back silently to defaults on any DB hiccup so a
 * preferences read never blocks a render.
 *
 * Use this from layouts / Server Components that want to project the
 * user's density / motion / theme preferences onto the SSR HTML
 * (e.g. `<div data-density="…">`) without round-tripping through the
 * Server Action surface.
 *
 * @module lib/preferences/server
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userPreferences, type UserPreferences } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { DEFAULT_THEME } from "@/lib/themes";

const log = logger.child({ module: "preferences-server" });

/**
 * Default preferences shape — mirrors the DB column defaults exactly.
 * Returned by `getPreferencesForSSR` when no row exists yet OR when the
 * DB read fails (so layouts never have to handle a null case).
 *
 * Duplicates the defaults in `lib/preferences/actions.ts::buildDefaults`
 * intentionally — the two modules are deliberately independent (this
 * one is SSR-leaf, the other is Server Action). If the shapes ever
 * drift, the integration tests in `lib/preferences/__tests__` will
 * catch the action side and the SSR side will quietly use the older
 * defaults — acceptable for what's effectively a hint to CSS.
 */
function buildSSRDefaults(userId: string): UserPreferences {
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

/**
 * Read a user's preferences row for SSR. Never throws, never returns
 * null — callers always get a populated shape.
 *
 * Pass the userId the caller already resolved from `readSession()` to
 * avoid a redundant cookie read. The function does NOT verify the user
 * still exists (the layout already gated on `readSession`); a stale
 * session that slipped through gets the defaults shape back, which is
 * the right CSS hint to send while the inevitable redirect fires.
 *
 * @param userId The session's userId.
 * @returns The persisted preferences row, or hard-coded defaults.
 */
export async function getPreferencesForSSR(
  userId: string,
): Promise<UserPreferences> {
  try {
    const [row] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return row ?? buildSSRDefaults(userId);
  } catch (err) {
    // DB hiccup — log and fall back to defaults so the layout renders.
    // The Server Action surface re-tries on the next user interaction.
    log.warn("getPreferencesForSSR failed, using defaults", { err, userId });
    return buildSSRDefaults(userId);
  }
}
