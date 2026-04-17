/**
 * Auth Zod schemas.
 *
 * Must live in a non-"use server" file so client components can import
 * them at runtime. Server Actions files are transformed — exported
 * values become remote-call stubs, not the original objects. A schema
 * imported from a "use server" file won't have its methods available.
 *
 * @module lib/auth/schemas
 */
import { z } from "zod";

/**
 * Login input shape. Used by both the client form (via an inline
 * resolver in app/login/page.tsx) and the server-side login action
 * (for re-validation). Single source of truth — never validate the
 * same data twice with different rules.
 */
export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address").toLowerCase(),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;
