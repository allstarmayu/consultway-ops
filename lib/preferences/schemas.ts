/**
 * Zod schemas for the user-preferences module.
 *
 * Used by both client form code (RHF resolver) and the Server Action
 * (re-validates input — never trusts the client).
 *
 * Theme id is validated against the live catalog in `lib/themes.ts`.
 * That coupling is intentional: deleting a palette from the catalog
 * should reject any stored preference for it on the next save, not let
 * a stale id linger forever.
 *
 * @module lib/preferences/schemas
 */
import { z } from "zod";
import { THEME_IDS } from "@/lib/themes";

// ── Field-level schemas ────────────────────────────────────────────────────

/**
 * Theme id — must match an entry in `THEME_IDS`. Non-empty string-shape
 * check first so the error message is friendlier on a `""` payload.
 */
const themeIdSchema = z
  .string()
  .min(1, "Pick a theme")
  .refine((v) => THEME_IDS.includes(v), {
    message: "That theme isn't available",
  });

const densitySchema = z.enum(["comfortable", "compact"]);

// ── Public schemas ─────────────────────────────────────────────────────────

/**
 * Patch shape for `updatePreferences`. Every field optional — the caller
 * passes only the fields they intend to change. Empty patch is a no-op
 * (the action short-circuits before hitting the DB).
 */
export const updatePreferencesSchema = z
  .object({
    themeId: themeIdSchema.optional(),
    density: densitySchema.optional(),
    reducedMotion: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
    monthlyReport: z.boolean().optional(),
    documentExpiry: z.boolean().optional(),
    tenderAlerts: z.boolean().optional(),
    assignmentAlerts: z.boolean().optional(),
    incidentAlerts: z.boolean().optional(),
  })
  .strict();

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
