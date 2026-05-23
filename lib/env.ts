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

  // ── R2 (object storage for documents) ───────────────────────────────
  // Cloudflare R2 is S3-API compatible. We hit it via sigv4-signed HTTPS
  // requests (aws4fetch), not the binding-injection approach - that's
  // a deployment-time concern handled separately in wrangler.jsonc.
  //
  // To get these values:
  //   1. `wrangler r2 bucket create consultway-docs` (one-time)
  //   2. Cloudflare dashboard -> R2 -> Manage R2 API Tokens
  //   3. Create Account API Token: Object Read & Write, scoped to the
  //      consultway-docs bucket, TTL Forever, no IP filter
  //   4. Copy the Access Key ID + Secret Access Key into .env.local
  //
  // Dev-only defaults are placeholder strings. They let the app boot
  // (so devs who haven't set up R2 can still work on unrelated features)
  // but any R2-API call made with them will fail loudly at sign time -
  // that's the desired failure mode. Production MUST set real values
  // via Cloudflare secrets.

  /**
   * Cloudflare account ID. Visible in the Cloudflare dashboard top-right
   * panel, also embedded in the R2 S3 endpoint URL (the hex prefix
   * before `.r2.cloudflarestorage.com`).
   */
  R2_ACCOUNT_ID: z.string().min(1).default("dev-placeholder-account-id"),

  /**
   * R2 access key ID. Minted alongside the secret key when creating an
   * R2 API token in the dashboard. Treat as a non-secret identifier
   * (it's logged on errors); the secret below is the actual secret.
   */
  R2_ACCESS_KEY_ID: z
    .string()
    .min(1)
    .default("dev-placeholder-access-key-id"),

  /**
   * R2 secret access key. NEVER log this. NEVER commit a real value.
   * `lib/logger.ts` doesn't auto-redact secrets - it's on the call site
   * to keep this out of log payloads. The Zod min(1) catches the
   * empty-string footgun but doesn't enforce a particular length
   * because Cloudflare's secret length isn't documented as stable.
   */
  R2_SECRET_ACCESS_KEY: z
    .string()
    .min(1)
    .default("dev-placeholder-secret-access-key"),

  /**
   * R2 bucket name. We use `consultway-docs` for both dev and prod;
   * environment separation is handled at the account level, not by
   * bucket name. If we add a staging bucket later (per the deployment
   * doc's `consultway-docs-staging` plan) this is where it gets pointed.
   */
  R2_BUCKET_NAME: z.string().min(1).default("consultway-docs"),

  // ── Email (Resend) ──────────────────────────────────────────────────
  // Day 10: transactional email is wired through `lib/email/client.ts`.
  // When `RESEND_API_KEY` is set, the client uses the Resend SDK to
  // actually send. When it's unset (the dev default), the client logs
  // the rendered payload via the structured logger and returns ok.
  //
  // This split lets the document expiry-reminder cron be invoked
  // locally via `pnpm cron:expiry-sweep` without a Resend account, and
  // gracefully upgrades to real sends in production where the key is
  // provisioned via Cloudflare secrets.

  /**
   * Resend API key. Optional in dev (empty string -> log fallback);
   * REQUIRED in production for transactional emails to actually go out.
   * Format: `re_<random>` (Resend's own token format; we don't validate
   * the shape beyond non-emptiness because Resend is free to rotate it).
   */
  RESEND_API_KEY: z.string().default(""),

  /**
   * `From` address for outbound transactional email. The format
   * `"Name <local@domain>"` is the Resend-and-RFC-5322 standard for
   * setting both the display name and the address. The default uses
   * `consultway.local` (an unroutable TLD) so a misconfigured dev
   * environment can't accidentally send from a real-looking address.
   *
   * Production sets this to the verified sender domain configured in
   * Resend (e.g. `noreply@consultway.info`).
   */
  EMAIL_FROM: z.string().min(1).default("Consultway <noreply@consultway.local>"),

  /**
   * Optional `Reply-To` address. When unset, replies route back to the
   * `From` address (which usually goes to a black-hole inbox for noreply
   * senders). Setting this points replies at a real support inbox.
   */
  EMAIL_REPLY_TO: z.string().optional(),
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

/**
 * Loud warnings when secret-ish vars still hold their dev-only placeholder
 * defaults at module load. The defaults are convenient for first-clone
 * onboarding (the app boots without any setup) but are catastrophic if
 * they slip into production unchanged. This catches that class of mistake
 * at the earliest possible point — server boot — instead of letting it
 * surface as a silent auth failure or a cryptic R2 SignatureDoesNotMatch
 * later.
 *
 * Day 11 follow-up to Day 9's "lost an hour to a silent pepper mismatch"
 * gotcha. Each warning is independent: setting four real values and
 * leaving one placeholder still warns about the remaining one.
 *
 * Suppressed in `NODE_ENV=test` so the test runner's stderr stays clean
 * (the test setup never reads real secrets anyway).
 *
 * Uses `console.warn` directly — `lib/logger.ts` depends on `env`, so
 * pulling the logger in here would create a circular import. Same
 * exception pattern as the validation-failure `console.error` above.
 */
function warnOnPlaceholderSecrets(parsed: z.infer<typeof envSchema>): void {
  if (parsed.NODE_ENV === "test") return;

  // Keep in sync with the `default(...)` values in `envSchema` above.
  // Each entry: [env key, the placeholder string, human-friendly hint].
  const placeholders: Array<readonly [keyof typeof parsed, string, string]> = [
    [
      "JWT_SECRET",
      "dev-only-jwt-secret-please-replace-in-production-environments",
      "JWT signing key — sessions will not be portable across deploys",
    ],
    [
      "PASSWORD_PEPPER",
      "dev-only-pepper-replace-in-prod",
      "password hash pepper — changing this invalidates every existing hash",
    ],
    [
      "R2_ACCOUNT_ID",
      "dev-placeholder-account-id",
      "R2 account id — every signed R2 request will fail at sign time",
    ],
    [
      "R2_ACCESS_KEY_ID",
      "dev-placeholder-access-key-id",
      "R2 access key id — every signed R2 request will fail at sign time",
    ],
    [
      "R2_SECRET_ACCESS_KEY",
      "dev-placeholder-secret-access-key",
      "R2 secret key — every signed R2 request will fail at sign time",
    ],
  ];

  for (const [key, placeholder, hint] of placeholders) {
    if (parsed[key] === placeholder) {
      // eslint-disable-next-line no-console
      console.warn(
        `⚠ ${key} is using the dev-only placeholder default. ${hint}.`,
      );
    }
  }
}

/** Validated environment. Prefer this over `process.env` everywhere. */
export const env = parseEnv();

warnOnPlaceholderSecrets(env);

/** Convenience boolean flags derived from NODE_ENV. */
export const isDev = env.NODE_ENV === "development";
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
