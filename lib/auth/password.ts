/**
 * Password hashing and verification.
 *
 * Uses bcryptjs (pure JS) instead of bcrypt (native C++) so the same
 * code runs in Node, Cloudflare Workers, and test runners. Slower than
 * native bcrypt (~2x), but at cost factor 10 it's still ~100ms per
 * hash — safe under Workers' CPU limits.
 *
 * Every password is combined with a server-side "pepper" (from env)
 * before hashing. The pepper is NOT stored in the database, so even
 * if the DB leaks, an attacker also needs the pepper to brute-force
 * hashes offline. Rotating the pepper invalidates every password in
 * the database, so treat it like a secret and keep it stable.
 *
 * @module lib/auth/password
 */
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";

/**
 * bcrypt cost factor. 10 is the industry default — ~100ms per hash on
 * modern hardware. Bumping this slows down both legitimate logins and
 * brute-force attempts proportionally. Safe to raise to 11 or 12 later
 * if we want more headroom; verify() handles mixed-cost hashes.
 */
const BCRYPT_COST = 10;

/**
 * Maximum plaintext length before hashing. bcrypt silently truncates
 * inputs longer than 72 bytes, which creates a subtle security bug
 * where `verylongpassword_A` and `verylongpassword_B` could hash to
 * the same value. We reject early to fail loudly instead.
 */
const MAX_PASSWORD_BYTES = 72;

/**
 * Hash a plaintext password with the server pepper.
 *
 * @param plaintext The user's password, already validated for strength
 *                  by Zod at the API layer (don't rely on this function
 *                  for strength enforcement).
 * @returns The bcrypt hash, safe to store in the database.
 * @throws If plaintext exceeds 72 bytes.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const peppered = plaintext + env.PASSWORD_PEPPER;
  const byteLength = Buffer.byteLength(peppered, "utf8");

  if (byteLength > MAX_PASSWORD_BYTES) {
    throw new Error(
      `Password too long: ${byteLength} bytes exceeds bcrypt's 72-byte limit`,
    );
  }

  return bcrypt.hash(peppered, BCRYPT_COST);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Uses bcrypt's built-in timing-safe comparison. Returns false for any
 * failure mode (wrong password, malformed hash, etc.) — never throws,
 * so callers can treat it as a pure boolean check.
 *
 * @param plaintext The password the user just typed.
 * @param hash      The bcrypt hash stored in users.password_hash.
 * @returns true if the password matches, false otherwise.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  try {
    const peppered = plaintext + env.PASSWORD_PEPPER;
    return await bcrypt.compare(peppered, hash);
  } catch {
    // Malformed hash, invalid format, etc. Treat as "wrong password"
    // rather than leaking internals to the caller.
    return false;
  }
}
