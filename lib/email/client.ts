/**
 * Transactional email - thin wrapper around the Resend SDK.
 *
 * Single entry point: `sendEmail({ to, subject, html, ... })`. Used by
 * the document expiry-reminder cron (Day 10) and (eventually) the
 * verification / password-reset flows.
 *
 * Behaviour split on `env.RESEND_API_KEY`:
 *
 *   - key set     -> instantiates the Resend client lazily on first call
 *                    and dispatches the email. Returns `{ ok: true, id }`
 *                    on success, `{ ok: false, error }` on failure (logs
 *                    the error; never throws). The returned id is
 *                    Resend's message id, useful for support tickets.
 *
 *   - key unset   -> log-fallback path. The full rendered payload is
 *                    emitted via the structured logger at info level so
 *                    devs running `pnpm cron:expiry-sweep` locally can
 *                    see exactly what would have gone out. Returns
 *                    `{ ok: true, id: "stub:..." }` so cron handlers
 *                    can treat the two paths identically.
 *
 * This split is what lets the Day 10 cron land "complete" without
 * forcing every contributor to provision a Resend account. Production
 * sets the key via Cloudflare secrets and gets real sends.
 *
 * Failure model:
 *   - Never throws. Cron handlers and Server Actions get a typed result
 *     they can branch on. A failed email should not break the calling
 *     action - if a status-flip succeeded but the email failed, the
 *     status flip stands.
 *
 * @module lib/email/client
 */
import { Resend } from "resend";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "email" });

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Inputs for sendEmail. Mirrors Resend's `emails.send` shape minus
 * the fields we don't currently use (attachments, headers, scheduling).
 * Adding those is straightforward if a future caller needs them.
 */
export interface SendEmailArgs {
  /** Single address or array. Resend handles both. */
  to: string | string[];
  /** Plain text subject. */
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /**
   * Optional plain-text fallback. Email clients with HTML disabled
   * (rare but exists - corporate filtering, terminal mail readers)
   * use this. Skipping it for now would still deliver but is poor
   * accessibility practice.
   */
  text?: string;
  /**
   * Per-send Reply-To override. When omitted, falls back to
   * `env.EMAIL_REPLY_TO`, then to the From address.
   */
  replyTo?: string;
}

/** Result type for sendEmail. */
export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

// ── Resend lazy client ────────────────────────────────────────────────────

/**
 * Module-scoped lazy Resend client. We defer construction so the
 * "no key set" path doesn't even instantiate the SDK; importing
 * `lib/email/client.ts` is side-effect-free until `sendEmail` runs
 * with a key present.
 */
let cachedClient: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new Resend(env.RESEND_API_KEY);
  return cachedClient;
}

// ── sendEmail ─────────────────────────────────────────────────────────────

/**
 * Send a transactional email. Routes through Resend when configured,
 * falls back to log-only in dev. Never throws.
 *
 * @example
 *   const result = await sendEmail({
 *     to: company.contactEmail,
 *     subject: "Document expiring in 14 days",
 *     html: renderExpiryReminder({...}).html,
 *     text: renderExpiryReminder({...}).text,
 *   });
 *   if (!result.ok) {
 *     log.warn("reminder send failed", { documentId, error: result.error });
 *   }
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const client = getClient();
  const replyTo = args.replyTo ?? env.EMAIL_REPLY_TO;

  // Fallback path: no Resend key configured. Log the full payload so
  // dev cron runs surface "what would have gone out" without sending.
  // The `id` returned is a sentinel string so callers can detect
  // fallback mode if they care (most don't - the ok:true contract is
  // identical).
  if (!client) {
    log.info("[email stub] would send", {
      to: args.to,
      from: env.EMAIL_FROM,
      subject: args.subject,
      // HTML can be huge - log the first 500 chars so the audit trail
      // has shape without bloating the log line. Full body is in code
      // anyway via the template module.
      htmlPreview: args.html.slice(0, 500),
      ...(args.text ? { textPreview: args.text.slice(0, 300) } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    return { ok: true, id: `stub:${Date.now()}` };
  }

  // Real-send path. Resend's SDK returns `{ data, error }` rather than
  // throwing on API errors - we mirror that shape into our result type.
  try {
    const { data, error } = await client.emails.send({
      from: env.EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      html: args.html,
      ...(args.text ? { text: args.text } : {}),
      ...(replyTo ? { replyTo } : {}),
    });

    if (error) {
      // Resend's error has `name` (a category) and `message`. We surface
      // the message; the name lands in the log for debugging.
      log.error("resend send failed", {
        to: args.to,
        subject: args.subject,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { ok: false, error: error.message };
    }

    if (!data?.id) {
      // Defensive: Resend SDK contract says one of data or error is
      // always set, but we don't trust 3p libraries on that.
      log.warn("resend send returned no id", {
        to: args.to,
        subject: args.subject,
      });
      return { ok: false, error: "Email provider returned no message id" };
    }

    log.info("email sent", {
      id: data.id,
      to: args.to,
      subject: args.subject,
    });
    return { ok: true, id: data.id };
  } catch (err) {
    // Network-level failure or SDK threw unexpectedly. Log + return
    // ok:false - never throw out to the caller.
    log.error("email send threw", {
      err,
      to: args.to,
      subject: args.subject,
    });
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Type alias exported for test mocks. Tests `vi.mock("@/lib/email/client")`
 * and need to type the mocked function to match.
 */
export type SendEmailFn = typeof sendEmail;
