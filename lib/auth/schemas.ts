/**
 * Auth Zod schemas.
 *
 * Must live in a non-"use server" file so client components can import
 * them at runtime. Server Actions files are transformed - exported
 * values become remote-call stubs, not the original objects. A schema
 * imported from a "use server" file won't have its methods available.
 *
 * @module lib/auth/schemas
 */
import { z } from "zod";

/**
 * Login input shape. Used by both the client form (via an inline
 * resolver in app/login/page.tsx) and the server-side login action
 * (for re-validation). Single source of truth - never validate the
 * same data twice with different rules.
 *
 * Day 6 addition: optional `from` field carrying the path the user was
 * trying to reach when proxy.ts bounced them to /login. Set as a
 * hidden form field, sourced from the URL query string (?from=...).
 * Named `from` to match the proxy's existing convention - the proxy
 * sets `?from=` on the redirect URL, and we round-trip the same name
 * back through the form.
 *
 * Open-redirect safety: the schema accepts ANY string here (we can't
 * easily express "path-only URL" in Zod's primitives), but the action
 * layer runs an explicit `safeFromPath()` validator before honouring
 * the value. Validation here would either be too loose (regex
 * approximations of URL grammar) or too strict (rejecting valid paths
 * with weird-but-legal characters). Cleaner to do the security-
 * critical check once, in the action, where the redirect call lives.
 */
export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address").toLowerCase(),
  password: z.string().min(1, "Password is required"),
  /** Post-login destination. Optional; defaults to /dashboard. */
  from: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

// ── Password strength (Day 15) ──────────────────────────────────────────────

/**
 * Public-registration / password-reset password rule.
 *
 * `lib/auth/password.ts` enforces only the bcrypt 72-byte upper bound — it
 * deliberately delegates strength rules to the API layer. This is the
 * canonical rule:
 *   - at least 10 chars (long enough to defeat trivial brute force, short
 *     enough to be human-typeable; we don't burden new signups with
 *     enterprise-policy 14-char requirements yet)
 *   - at least one letter
 *   - at least one number
 *
 * The bcrypt module's own 72-byte limit is checked by `hashPassword` and
 * surfaces as a thrown error if a user somehow defeats the Zod max (e.g.
 * `\u{1F4A9}` emojis are 4 bytes each in UTF-8). 72 chars upper bound
 * keeps us well clear in the common case.
 *
 * Exported separately so the password-reset schema (Chunk 3) can reuse it.
 */
export const passwordPolicySchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(72, "Password must be 72 characters or fewer")
  .refine((v) => /[A-Za-z]/.test(v), {
    message: "Password must contain at least one letter",
  })
  .refine((v) => /[0-9]/.test(v), {
    message: "Password must contain at least one number",
  });

// ── Registration (Day 15) ───────────────────────────────────────────────────

/**
 * Indian GSTIN format. 15 chars: 2 digits state + 10-char PAN + entity
 * + Z + check. Mirrors `lib/companies/schemas.ts` — duplicated rather
 * than re-imported because the auth schemas live one layer below
 * companies (registration creates a company; the dep arrow should point
 * down, not up).
 */
const gstinRegex =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** Indian PAN format. 10 chars: 5 letters, 4 digits, 1 letter. */
const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

/**
 * Public registration input.
 *
 * The shape mirrors create-company's first-page fields PLUS the user
 * creation fields needed to mint the linked auth account. Cross-validated
 * via `superRefine`:
 *   - `userEmail` defaults to `contactEmail` when blank (so a single-email
 *     workflow is the common case; separate emails are an opt-in)
 *   - `acceptedTerms` must be `true`
 *
 * GST/PAN format validation matches the admin-create-company convention
 * (`lib/companies/schemas.ts` enforces format-when-present, NULL-when-
 * absent). Same regex, same trade-off — empty string is treated as "not
 * provided" via `transform`.
 */
export const registerCompanySchema = z
  .object({
    // ── Company fields ──
    companyName: z
      .string()
      .trim()
      .min(2, "Company name must be at least 2 characters")
      .max(200, "Company name must be 200 characters or fewer"),
    sector: z
      .string()
      .trim()
      .min(2, "Sector is required")
      .max(100, "Sector must be 100 characters or fewer"),
    geography: z
      .string()
      .trim()
      .min(2, "Geography is required")
      .max(100, "Geography must be 100 characters or fewer"),

    // GST and PAN: blank => null; present => must match format.
    gstNumber: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .refine((v) => v === null || gstinRegex.test(v), {
        message: "Enter a valid 15-character GSTIN",
      }),
    panNumber: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .refine((v) => v === null || panRegex.test(v), {
        message: "Enter a valid 10-character PAN",
      }),

    contactPersonName: z
      .string()
      .trim()
      .min(2, "Contact person name is required")
      .max(200, "Contact name must be 200 characters or fewer"),
    contactPhone: z
      .string()
      .trim()
      .min(7, "Phone number too short")
      .max(20, "Phone number too long"),
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Enter a valid contact email address"),

    // ── User fields ──
    userName: z
      .string()
      .trim()
      .min(2, "Your name is required")
      .max(200, "Name must be 200 characters or fewer"),
    /**
     * User login email. Optional in the form; falls back to contactEmail
     * via `superRefine` below. The transform normalises empty -> empty
     * (not undefined) so the union with the lowercase email branch stays
     * straightforward.
     */
    userEmail: z
      .string()
      .trim()
      .toLowerCase()
      .default("")
      .refine(
        (v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
        { message: "Enter a valid email address" },
      ),
    password: passwordPolicySchema,

    /**
     * Terms-of-service acceptance. `z.literal(true)` rejects both
     * `false` and missing/undefined with the same message.
     */
    acceptedTerms: z.literal(true, {
      message: "You must accept the terms of service to register",
    }),
  })
  .superRefine((data, ctx) => {
    // If userEmail was left blank, fall back to contactEmail. We mutate
    // the parsed object via `ctx.addIssue` only on failure — the actual
    // default is applied below via a transform.
    const effectiveUserEmail =
      data.userEmail === "" ? data.contactEmail : data.userEmail;
    if (!effectiveUserEmail) {
      ctx.addIssue({
        code: "custom",
        path: ["userEmail"],
        message: "An email address is required for the user account",
      });
    }
  })
  .transform((data) => ({
    ...data,
    userEmail: data.userEmail === "" ? data.contactEmail : data.userEmail,
  }));

export type RegisterCompanyInput = z.infer<typeof registerCompanySchema>;

// ── Email verification + password reset (Chunks 2 + 3) ─────────────────────

/**
 * Input for `resendVerificationEmail`. Always returns ok regardless of
 * whether the email exists — enumeration defence lives in the action.
 */
export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

/**
 * Input for `requestPasswordReset`. Same enumeration-defended shape as
 * resend verification.
 */
export const requestPasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export type RequestPasswordResetInput = z.infer<
  typeof requestPasswordResetSchema
>;

/**
 * Input for `resetPassword`. `token` is the raw URL-safe hex string we
 * minted; `newPassword` is checked against the same policy as
 * registration.
 */
export const resetPasswordSchema = z.object({
  token: z
    .string()
    .min(16, "Reset link is invalid")
    .max(256, "Reset link is invalid"),
  newPassword: passwordPolicySchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
