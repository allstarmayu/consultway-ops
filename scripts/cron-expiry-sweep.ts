/**
 * Local invocation script for the document expiry-sweep cron.
 *
 * Run via:
 *   pnpm cron:expiry-sweep
 *
 * What it does:
 *   - Loads `.env.local` via dotenv/config so RESEND_API_KEY +
 *     NEXT_PUBLIC_APP_URL are visible.
 *   - Calls `runExpirySweep` against the local SQLite + the real
 *     `sendEmail` function. When RESEND_API_KEY is unset, the email
 *     client logs payloads instead of sending - perfect for local
 *     verification without spamming real inboxes.
 *   - Prints the result summary + exits cleanly.
 *
 * Production note: this script is a local-only convenience. The
 * production cron entry point is the Cloudflare scheduled handler
 * (deferred to a deployment-wiring session); when that lands, the
 * scheduled handler will call `runExpirySweep` with the same shape.
 *
 * @module scripts/cron-expiry-sweep
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email/client";
import { runExpirySweep } from "@/lib/documents/crons/expiry-sweep";

const log = logger.child({ module: "cron-expiry-sweep" });

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  log.info("expiry-sweep starting", {
    today,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    emailMode: env.RESEND_API_KEY ? "resend" : "stub-log",
  });

  const result = await runExpirySweep({
    db,
    logger: log,
    sendEmail,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    today,
  });

  log.info("expiry-sweep done", { ...result });
  // eslint-disable-next-line no-console
  console.log("\nResult:", JSON.stringify(result, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    log.error("expiry-sweep crashed", { err });
    process.exit(1);
  },
);
