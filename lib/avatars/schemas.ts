/**
 * Zod schemas for the avatars module.
 *
 * Lives in a non-`"use server"` file so both client and server can import
 * these. Server Actions in `./actions.ts` re-validate every input with
 * these same schemas — never trust client validation alone.
 *
 * Two-step upload flow (mirrors `lib/documents/schemas.ts` shape but
 * lighter-weight): the client first calls `initiateAvatarUpload` which
 * mints a presigned R2 PUT URL but **does NOT write the DB**. The
 * client streams bytes directly to R2 with that URL, then calls
 * `confirmAvatarUpload` to write `users.avatar_key`. An abandoned
 * `initiate` call leaves no DB trace — only a (possibly empty) R2
 * object that the next confirm-on-replace will clean up.
 *
 * Why no pending row: avatars have a single canonical address
 * (`users.avatar_key`) rather than per-upload row identity like
 * documents. A "pending avatar" doesn't compose — the current avatar
 * stays valid right up until confirm flips the column. Skipping the
 * pending row eliminates the orphan-cleanup cron that documents need.
 *
 * @module lib/avatars/schemas
 */
import { z } from "zod";

// ── Upload limits ──────────────────────────────────────────────────────────

/**
 * Maximum avatar upload size in bytes. 5 MB is generous for a profile
 * photo — modern phone cameras output 2-4 MB JPEGs at full resolution,
 * and we don't need full-res for a 64×64 / 128×128 display anyway.
 * Smaller than the 10 MB documents cap because document scans of
 * multi-page certificates legitimately get bigger; an avatar that
 * needs more than 5 MB is almost certainly an unintended fullsize
 * upload that should be resized.
 *
 * Enforced here at the Zod layer (rejects oversized requests before
 * we mint the presigned URL). R2 itself doesn't enforce the limit
 * at sign time — same gap as documents — but a misbehaving client
 * uploading 50 MB just wastes their own bytes; the column points at
 * the latest confirm regardless.
 *
 * Exported so the client-side file picker can pre-flight-reject.
 */
export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Allowed MIME types for avatar uploads. Narrower than the documents
 * allowlist — no PDF (not a sensible avatar shape) and intentionally
 * no SVG (script injection vector) / no HEIC (Apple-specific, needs
 * server-side conversion).
 *
 * If we ever add `image/avif` here we'll also need to confirm the
 * <Image> next/image fallback in the Avatar component handles it on
 * the older browsers we care about.
 *
 * Exported so the client-side file picker can apply the same set in
 * its `accept` attribute and `change` handler.
 */
export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Zod schema form of the avatar MIME-type allow-list. */
const avatarMimeTypeSchema = z.enum(ALLOWED_AVATAR_MIME_TYPES);

// ── initiateAvatarUpload ───────────────────────────────────────────────────

/**
 * Input schema for `initiateAvatarUpload`.
 *
 * Design notes:
 *   - `fileName` is the original filename. Sanitised before becoming
 *     part of the R2 key (see `lib/r2/keys.ts::buildAvatarKey`).
 *   - `sizeBytes` is what the client claims the file is. Same
 *     limitation as documents: R2 doesn't enforce content-length at
 *     sign time, so a misbehaving client could upload bigger. For
 *     avatars the blast radius is "their own bytes in their own
 *     slot" — not worth a content-length-range condition today.
 *   - `mimeType` is bound into the presigned URL. The client MUST
 *     send the same value on the actual PUT or R2 rejects with
 *     SignatureDoesNotMatch.
 *
 * `.strict()` rejects unknown keys so a client attempting to sneak
 * a `userId` parameter fails loudly — the action resolves the user
 * from the session, never from input.
 */
export const initiateAvatarUploadSchema = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1, "File name is required")
      .max(255, "File name must be 255 characters or fewer"),

    mimeType: avatarMimeTypeSchema,

    sizeBytes: z.coerce
      .number()
      .int("File size must be a whole number of bytes")
      .positive("File size must be positive")
      .max(
        MAX_AVATAR_SIZE_BYTES,
        `Image must be ${MAX_AVATAR_SIZE_BYTES / (1024 * 1024)} MB or smaller`,
      ),
  })
  .strict();

export type InitiateAvatarUploadInput = z.infer<
  typeof initiateAvatarUploadSchema
>;

// ── confirmAvatarUpload ────────────────────────────────────────────────────

/**
 * Input schema for `confirmAvatarUpload`. The client passes back the
 * exact `avatarKey` that `initiateAvatarUpload` returned.
 *
 * The action layer ALSO validates the key starts with the per-user
 * prefix (`avatars/{session.userId}/`) — this Zod gate is just shape
 * validation. Without the prefix gate at the action layer, a malicious
 * client could submit `avatars/{otherUserId}/...` and overwrite their
 * own row's column to point at someone else's blob.
 */
export const confirmAvatarUploadSchema = z
  .object({
    avatarKey: z
      .string()
      .trim()
      .min(1, "Avatar key is required")
      .max(512, "Avatar key is implausibly long"),
  })
  .strict();

export type ConfirmAvatarUploadInput = z.infer<
  typeof confirmAvatarUploadSchema
>;
