/**
 * Environment variable validation.
 *
 * All env-var access in the app goes through this module. Import `env`
 * (not `process.env`) from anywhere else — it's pre-validated and typed.
 *
 * Validation runs at module load time (first import). Missing or
 * malformed vars cause an immediate process crash with a clear error,
 * which is what we want — better to fail at boot than 10 layers deep
 * in a request handler.
 *
 * @module lib/env
 */
import { z } from "zod";

/**
 * Schema for all environment variables the app reads.
 *
 * Keep in sync with `.env.example`. When adding a new var:
 *   1. Add it to `.env.example` with a placeholder
 *   2. Add it here with the right Zod validator
 *   3. Add it to the Cloudflare dashboard (staging + prod) before deploying
 */
const envSchema = z.object({
  // ── Core ────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("Consultway Ops"),

  // ── Secrets (32+ chars, generated via `openssl rand -base64 32`) ────
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters")
    .default(
      // Dev-only fallback so `pnpm dev` works out-of-the-box after clone.
      // Production MUST set a real value via Cloudflare secrets.
      "dev-only-jwt-secret-please-replace-in-production-environments",
    ),
  PASSWORD_PEPPER: z
    .string()
    .min(16, "PASSWORD_PEPPER must be at least 16 characters")
    .default("dev-only-pepper-replace-in-prod"),

  // ── Database ────────────────────────────────────────────────────────
  // Only used by drizzle-kit (CLI) and local dev. In Workers runtime,
  // the DB binding comes from env.DB (wrangler.jsonc), not this path.
  DATABASE_URL: z.string().default("./.wrangler/consultway-local.sqlite"),

  // ── Observability ───────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

/**
 * Parsed + validated env.
 *
 * Throws at module load if any required var is missing. Error message
 * includes the field path so it's easy to trace.
 */
function parseEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");

    // eslint-disable-next-line no-console
    console.error(`\n❌ Invalid environment variables:\n${issues}\n`);
    throw new Error("Environment validation failed. See errors above.");
  }

  return result.data;
}

/** Validated environment. Prefer this over `process.env` everywhere. */
export const env = parseEnv();

/** Convenience boolean flags derived from NODE_ENV. */
export const isDev = env.NODE_ENV === "development";
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
