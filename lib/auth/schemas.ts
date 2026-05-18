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
