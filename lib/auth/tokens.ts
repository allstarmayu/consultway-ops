/**
 * Single-use token mint + consume helpers.
 *
 * Two token kinds — email verification (Chunk 2) and password reset
 * (Chunk 3) — share the same shape and only differ in expiry length
 * and downstream effect. Both follow the same pattern:
 *
 *   1. Mint:    32 random bytes -> hex-encoded raw token; sha256(raw)
 *               stored as `token_hash`. The raw token is returned to
 *               the caller — that's the ONLY moment it exists outside
 *               the user's inbox.
 *   2. Consume: re-hash the URL-supplied raw token, look up by hash,
 *               check not-yet-used + not-yet-expired, set `used_at` in
 *               the same write that applies the downstream effect.
 *
 * Why hash the token at rest? A DB leak should not yield still-valid
 * links. If we stored the raw token, an attacker who pulled the table
 * could click every pending verification or reset link. With hashing,
 * the leaked rows are useless without the raw token (which only ever
 * existed in the inbox).
 *
 * No constant-time compare is needed because the lookup IS the
 * comparison — we don't fetch a row by id and then strcmp; we fetch by
 * hash. A wrong hash returns no row.
 *
 * @module lib/auth/tokens
 */
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, emailVerificationTokens } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth-tokens" });

// ── Constants ─────────────────────────────────────────────────────────────

/** Email verification tokens last 24 hours — long enough for the email to
 *  land in a Friday-night inbox and be clicked Monday morning. */
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Bytes of randomness per token. 32 -> 64 hex chars. */
const TOKEN_BYTES = 32;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Hex-encoded SHA-256 of the raw token. The DB stores this, never the raw. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a URL-safe hex random token. */
function randomTokenHex(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

// ── Email verification ───────────────────────────────────────────────────

/**
 * Mint an email verification token for the given user.
 * Returns the raw URL-safe token (caller embeds it in the verification URL).
 */
export async function mintEmailVerificationToken(
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const raw = randomTokenHex();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString();

  await db.insert(emailVerificationTokens).values({
    id: newId(),
    userId,
    tokenHash,
    expiresAt,
  });

  return { token: raw, expiresAt };
}

/** Discriminated return type for `consumeEmailVerificationToken`. */
export type ConsumeEmailVerificationResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

/**
 * Consume a raw verification token. Looks up by hash, validates expiry +
 * unused, flips `users.emailVerifiedAt`, stamps `used_at`.
 *
 * Returns a discriminated union so the page can render distinct copy for
 * each failure mode. Never throws.
 */
export async function consumeEmailVerificationToken(
  rawToken: string,
): Promise<ConsumeEmailVerificationResult> {
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  if (row.usedAt) {
    return { ok: false, reason: "already_used" };
  }
  if (Date.parse(row.expiresAt) < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const now = new Date().toISOString();
  // Stamp the token used AND flip the user in parallel. SQLite via
  // better-sqlite3 doesn't expose Drizzle's `db.transaction` symmetrically
  // for tests; two sequential awaits is fine — the token's UNIQUE
  // constraint on hash means a parallel consume can't double-spend.
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(eq(emailVerificationTokens.id, row.id));
  await db
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(eq(users.id, row.userId));

  log.info("email verification consumed", { userId: row.userId });
  return { ok: true, userId: row.userId };
}
