/**
 * Zod schemas for the user-profile module.
 *
 * Used by both the client form (RHF inline-resolver pattern) and the
 * `updateProfile` Server Action (re-validates input — never trusts the
 * client). Lives in a non-`"use server"` file so client components can
 * import without the schema being transformed into a remote-call stub.
 *
 * As of Day 28, three fields persist: `name`, `phone`, `jobTitle`.
 * Email is still deferred (needs a verify-old + verify-new flow before
 * we let users change their primary identifier).
 *
 *   - **`name`** is required on every save (display identity).
 *   - **`phone`** is optional and clearable. Pass null (or omit) to
 *     clear. Free-text — no E.164 normalisation, since users in India
 *     write numbers in many shapes (+91 prefix, raw 10-digit, with
 *     spaces / hyphens) and phone isn't an authentication factor here.
 *   - **`jobTitle`** is optional and clearable. Free text for display.
 *
 * Length bounds for `name` (min 2 / max 120) mirror
 * `registerCompanySchema.userName` in `lib/auth/schemas.ts` — the user
 * already passed this envelope at registration, so the same shape is
 * the right contract for subsequent edits. Phone caps at 32 chars
 * (comfortably covers `+91 98765 43210` and any international formats);
 * jobTitle reuses the 120-char cap.
 *
 * `.strict()` rejects unknown keys at runtime so a client trying to
 * sneak `email` fails loudly rather than silently being ignored.
 *
 * @module lib/profile/schemas
 */
import { z } from "zod";

/**
 * Patch shape for `updateProfile`. The action only writes the fields
 * that are present in the parsed object — explicit `null` clears a
 * column, `undefined` (or omitting the key) leaves it alone.
 */
export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(120, "Name must be 120 characters or fewer"),

    /**
     * Optional phone. Pass null to clear. Trim + length-bound but no
     * format check — phone isn't an auth factor today, see schema
     * docstring. An explicit empty string after trimming is treated as
     * null (the action coerces) so the form's "user emptied the input"
     * gesture round-trips cleanly.
     */
    phone: z
      .union([
        z
          .string()
          .trim()
          .max(32, "Phone must be 32 characters or fewer"),
        z.null(),
      ])
      .optional(),

    /**
     * Optional job title. Same shape as phone — trimmed, length-bound,
     * empty string coerced to null at the action layer.
     */
    jobTitle: z
      .union([
        z
          .string()
          .trim()
          .max(120, "Job title must be 120 characters or fewer"),
        z.null(),
      ])
      .optional(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
