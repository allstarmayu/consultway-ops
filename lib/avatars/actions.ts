/**
 * Avatars module — Server Actions.
 *
 * Three actions covering the user's profile-photo lifecycle:
 *   - `initiateAvatarUpload` — mint a presigned R2 PUT URL. NO DB write
 *     at this step; an abandoned initiate leaves no trace.
 *   - `confirmAvatarUpload`  — after a successful R2 PUT, point
 *     `users.avatar_key` at the new key, audit, and best-effort delete
 *     the old R2 object if the new key differs from the previous one.
 *   - `deleteAvatar`         — clear the column, best-effort delete the
 *     R2 object, audit.
 *
 * Why the two-step flow (vs a single "upload everything" Server
 * Action): R2 takes bytes via a presigned PUT directly from the
 * browser, bypassing our Worker entirely. That sidesteps the Workers
 * 100 MB request-body limit and saves egress + CPU. Documents use the
 * same pattern.
 *
 * Why no pending row (unlike documents): avatars have a single
 * canonical address (`users.avatar_key`); there's no per-upload row
 * identity to thread through a "pending → confirmed" state machine.
 * The current avatar stays valid right up until confirm flips the
 * column. Trade-off: an abandoned initiate leaves a (probably empty)
 * R2 object that nothing cleans up until the user uploads again. For
 * Phase 1 we accept the rare orphan; if it becomes load-bearing we
 * can add a cron similar to `documents/pending-cleanup`.
 *
 * Authorization on every action:
 *   - Must be signed in (no anonymous avatar play).
 *   - Stale-session guard via `assertUserExists` — same shape as
 *     preferences and profile actions.
 *   - On confirm: the submitted `avatarKey` MUST start with
 *     `avatars/{session.userId}/`. Without this gate, a malicious
 *     client could submit someone else's key and point their own
 *     row's column at a blob they don't own.
 *
 * @module lib/avatars/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { assertUserExists, readSession } from "@/lib/auth/session";
import { STALE_SESSION_ERROR } from "@/lib/auth/stale-session";
import { recordAuditEvent } from "@/lib/audit/log";
import { logger } from "@/lib/logger";
import { deleteR2Object, getPresignedPutUrl } from "@/lib/r2/client";
import { avatarKeyPrefixFor, buildAvatarKey } from "@/lib/r2/keys";
import type { ActionResult } from "@/lib/types/action-result";
import {
  confirmAvatarUploadSchema,
  initiateAvatarUploadSchema,
  type ConfirmAvatarUploadInput,
  type InitiateAvatarUploadInput,
} from "./schemas";

const log = logger.child({ module: "avatars-actions" });

// ── initiateAvatarUpload ────────────────────────────────────────────────────

/**
 * Successful return shape — everything the client needs to perform the
 * R2 PUT and then call `confirmAvatarUpload`.
 */
export interface InitiateAvatarUploadSuccess {
  /** Presigned PUT URL. Sigv4 binds the content-type at sign time. */
  uploadUrl: string;
  /**
   * R2 object key the client should pass back to `confirmAvatarUpload`.
   * Same value the action would have used internally — the client
   * never gets to choose the key.
   */
  avatarKey: string;
  /**
   * The content-type the client MUST send on the PUT. R2 rejects
   * mismatches with SignatureDoesNotMatch, so we echo it explicitly
   * even though the client originally supplied it.
   */
  contentType: string;
  expiresInSeconds: number;
}

/**
 * Step 1 of the avatar upload flow. Validates input, builds the R2
 * key for the signed-in user, and returns a presigned PUT URL. Does
 * NOT touch the DB.
 *
 * The client then performs `PUT <uploadUrl>` with the file bytes and
 * the `Content-Type: <contentType>` header set EXACTLY to the value
 * returned here. Mismatches surface as 403 SignatureDoesNotMatch
 * from R2.
 */
export async function initiateAvatarUpload(
  rawInput: InitiateAvatarUploadInput,
): Promise<ActionResult<InitiateAvatarUploadSuccess>> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  if (!(await assertUserExists(session.userId))) {
    log.warn("stale session — user no longer exists", {
      userId: session.userId,
    });
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const parsed = initiateAvatarUploadSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Invalid input",
      field: issue?.path[0]?.toString(),
    };
  }

  const input = parsed.data;
  const avatarKey = buildAvatarKey(session.userId, input.fileName);

  const presigned = await getPresignedPutUrl(avatarKey, input.mimeType);

  log.info("avatar upload initiated", {
    userId: session.userId,
    avatarKey,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
  });

  return {
    ok: true,
    uploadUrl: presigned.url,
    avatarKey,
    contentType: input.mimeType,
    expiresInSeconds: presigned.expiresInSeconds,
  };
}

// ── confirmAvatarUpload ─────────────────────────────────────────────────────

/**
 * Successful return shape. The client uses `avatarKey` to ask
 * `getAvatarDisplayUrl` for a fresh GET URL after the upload.
 */
export interface ConfirmAvatarUploadSuccess {
  avatarKey: string;
}

/**
 * Step 2 of the avatar upload flow. Points `users.avatar_key` at the
 * key the client uploaded to, emits an audit event, and best-effort
 * deletes the previous R2 object if it existed AND was different from
 * the new one (same key = R2 already overwrote bytes, no delete
 * needed).
 *
 * The client is expected to have completed the R2 PUT before calling
 * this. We don't verify the object exists in R2 — the next GET will
 * fail loudly if the upload didn't actually land. Verifying here
 * would cost a HEAD round-trip per confirm; the failure mode (broken
 * image in the UI until next upload) is recoverable.
 */
export async function confirmAvatarUpload(
  rawInput: ConfirmAvatarUploadInput,
): Promise<ActionResult<ConfirmAvatarUploadSuccess>> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  if (!(await assertUserExists(session.userId))) {
    log.warn("stale session — user no longer exists", {
      userId: session.userId,
    });
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const parsed = confirmAvatarUploadSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Invalid input",
      field: issue?.path[0]?.toString(),
    };
  }

  // Authorization gate — the submitted key MUST belong to the signed-in
  // user's prefix. Without this, a malicious client could submit
  // `avatars/{otherUserId}/...` and overwrite their own column to
  // claim someone else's blob. Belt-and-braces: even if it succeeded
  // server-side, the R2 ACL doesn't allow cross-user reads, but the
  // bookkeeping would still be wrong.
  const prefix = avatarKeyPrefixFor(session.userId);
  if (!parsed.data.avatarKey.startsWith(prefix)) {
    log.warn("avatar key does not match signed-in user's prefix", {
      userId: session.userId,
      avatarKey: parsed.data.avatarKey,
    });
    return {
      ok: false,
      error: "Invalid avatar key",
      field: "avatarKey",
    };
  }

  const nextKey = parsed.data.avatarKey;

  // Read the current avatar_key so we can audit the diff AND know
  // whether to clean up an old R2 object.
  const [existing] = await db
    .select({ avatarKey: users.avatarKey })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!existing) {
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const previousKey = existing.avatarKey;

  // No-op short-circuit — already pointing at the same key. The R2
  // PUT may have rewritten bytes, but the column doesn't change and
  // there's no diff to audit.
  if (previousKey === nextKey) {
    return { ok: true, avatarKey: nextKey };
  }

  await db
    .update(users)
    .set({ avatarKey: nextKey })
    .where(eq(users.id, session.userId));

  log.info("avatar key updated", {
    userId: session.userId,
    previousKey,
    nextKey,
  });

  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: "updated",
    targetType: "user",
    targetId: session.userId,
    before: { avatarKey: previousKey },
    after: { avatarKey: nextKey },
  });

  // Best-effort cleanup of the previous R2 object. Failure here logs
  // but doesn't fail the action — the DB column already points at
  // the new key, so the avatar is live. Leaking the old blob is a
  // bandwidth/storage problem at worst, not a correctness problem.
  if (previousKey && previousKey !== nextKey) {
    const result = await deleteR2Object(previousKey);
    if (!result.ok) {
      log.warn("previous avatar R2 cleanup failed", {
        previousKey,
        status: result.status,
      });
    }
  }

  return { ok: true, avatarKey: nextKey };
}

// ── deleteAvatar ────────────────────────────────────────────────────────────

/**
 * Clear the signed-in user's avatar. Sets `users.avatar_key = NULL`,
 * best-effort deletes the R2 object, and audits the change.
 *
 * No-op short-circuit: if the column was already NULL, no DB write,
 * no audit, no R2 call. The action still returns `ok: true` so the
 * caller doesn't have to special-case it.
 */
export async function deleteAvatar(): Promise<ActionResult<{ avatarKey: null }>> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  if (!(await assertUserExists(session.userId))) {
    log.warn("stale session — user no longer exists", {
      userId: session.userId,
    });
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const [existing] = await db
    .select({ avatarKey: users.avatarKey })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!existing) {
    return { ok: false, error: STALE_SESSION_ERROR };
  }

  const previousKey = existing.avatarKey;

  if (previousKey === null) {
    // No-op — already cleared.
    return { ok: true, avatarKey: null };
  }

  await db
    .update(users)
    .set({ avatarKey: null })
    .where(eq(users.id, session.userId));

  log.info("avatar cleared", {
    userId: session.userId,
    previousKey,
  });

  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: "updated",
    targetType: "user",
    targetId: session.userId,
    before: { avatarKey: previousKey },
    after: { avatarKey: null },
  });

  // Best-effort R2 cleanup. Same rationale as in confirm.
  const result = await deleteR2Object(previousKey);
  if (!result.ok) {
    log.warn("R2 cleanup on deleteAvatar failed", {
      previousKey,
      status: result.status,
    });
  }

  return { ok: true, avatarKey: null };
}
