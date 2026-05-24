/**
 * Zod schemas for the user-profile module.
 *
 * Used by both the client form (RHF inline-resolver pattern) and the
 * `updateProfile` Server Action (re-validates input — never trusts the
 * client). Lives in a non-`"use server"` file so client components can
 * import without the schema being transformed into a remote-call stub.
 *
 * Name bounds (min 2, max 120) mirror `registerCompanySchema.userName`
 * in `lib/auth/schemas.ts` — the user already passed this length check
 * at registration, so the same envelope is the right contract for
 * subsequent edits. 120 is comfortably under the bcrypt password limit
 * we use elsewhere and well within SQLite's TEXT column limits.
 *
 * Why a one-field schema instead of a wider Profile shape: phone /
 * email / jobTitle persistence is deferred (phone needs a schema
 * migration, email needs a verification flow). Keeping the schema
 * narrow now means we don't accidentally accept fields the action
 * doesn't write — clearer contract, smaller blast radius.
 *
 * @module lib/profile/schemas
 */
import { z } from "zod";

/**
 * Patch shape for `updateProfile`. Only `name` is writable this round.
 * `strict()` rejects unknown keys so a client passing `phone` would
 * fail loudly rather than silently being ignored — that surfaces the
 * "this round only does name" contract at the validation layer.
 */
export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(120, "Name must be 120 characters or fewer"),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
