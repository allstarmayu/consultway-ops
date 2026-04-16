/**
 * UUID primary-key helpers.
 *
 * Every table uses UUID v7 primary keys (not v4). UUID v7 embeds a
 * millisecond timestamp in the first 48 bits, so new rows sort
 * chronologically in the B-tree index — far friendlier to SQLite's
 * index pages than v4's pure randomness. Same 128-bit format, same
 * string length, drop-in replacement.
 *
 * Always call `newId()` — never `crypto.randomUUID()` (which is v4)
 * or `uuidv7()` directly. Keeping a single entry point means if we
 * ever want to swap to ULID or change the ID strategy, there's one
 * file to edit.
 *
 * @module lib/db/ids
 */
import { v7 as uuidv7 } from "uuid";

/**
 * Generate a new UUID v7. Use this for all new primary keys.
 *
 * @example
 *   const id = newId();
 *   await db.insert(users).values({ id, email, ... });
 */
export function newId(): string {
  return uuidv7();
}
