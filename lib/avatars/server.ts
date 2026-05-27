/**
 * SSR-friendly avatar URL minter.
 *
 * `lib/avatars/actions.ts` is `"use server"` — Server Actions only.
 * Server Components (e.g. `app/dashboard/settings/page.tsx`) that need
 * a presigned GET URL to display a user's avatar can't go through the
 * actions module without each export becoming a remote-call stub. This
 * module exposes a thin helper that takes the `avatarKey` the caller
 * already read from `users.avatar_key` and returns a fresh presigned
 * GET URL (or null).
 *
 * Contract:
 *   - **Never throws.** R2 sign failures (network / auth misconfig)
 *     surface as a null return + a logged warning. The Avatar
 *     component falls back to initials.
 *   - **Returns null for null input.** Callers don't have to special-
 *     case the no-avatar case.
 *
 * Same pattern + same rationale as `lib/preferences/server.ts`. Use
 * this from any Server Component / layout that wants to display an
 * avatar; don't import from `actions.ts`.
 *
 * @module lib/avatars/server
 */
import { getPresignedGetUrl } from "@/lib/r2/client";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "avatars-server" });

/**
 * Mint a presigned GET URL for an avatar. Returns null when there's
 * no key OR when the sign call fails — Server Components never have
 * to handle a thrown exception from this helper.
 *
 * Pass the avatarKey the caller already resolved from
 * `users.avatar_key`. The presign uses the standard 5-minute window
 * (same as documents); browsers cache the image for the URL's
 * lifetime, and a stale URL just 404s and the Avatar falls back to
 * initials on the next render.
 *
 * @param avatarKey The user's stored avatar key (or null).
 * @returns The presigned GET URL, or null.
 */
export async function getAvatarDisplayUrl(
  avatarKey: string | null,
): Promise<string | null> {
  if (!avatarKey) return null;

  try {
    const presigned = await getPresignedGetUrl(avatarKey);
    return presigned.url;
  } catch (err) {
    // R2 sign failure — log and return null so the Avatar component
    // renders initials. The action surface will surface a real error
    // when the user next tries to upload, which is the right time
    // to alarm.
    log.warn("getAvatarDisplayUrl failed, falling back to null", {
      err,
      avatarKey,
    });
    return null;
  }
}
