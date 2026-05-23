/**
 * Local invocation script for the expired-token cleanup cron.
 *
 * Run via:
 *   pnpm cron:token-cleanup
 *
 * What it does:
 *   - Loads `.env.local` via dotenv/config.
 *   - Calls `cleanupExpiredTokens` against the local SQLite, sweeping
 *     every expired row out of `email_verification_tokens` and
 *     `password_reset_tokens`.
 *   - Prints the per-table delete counts + exits cleanly.
 *
 * Production note: same as `cron-expiry-sweep.ts` /
 * `cron-pending-cleanup.ts` — this is a local convenience. The
 * Cloudflare scheduled handler will dispatch the cleanup in production
 * when the OpenNext deployment wiring lands; the trigger entry is
 * already in `wrangler.jsonc` (4 AM UTC daily, sequenced after the
 * other two sweeps).
 *
 * @module scripts/cron-token-cleanup
 */
import "dotenv/config";
import { logger } from "@/lib/logger";
import { cleanupExpiredTokens } from "@/lib/auth/tokens";

const log = logger.child({ module: "cron-token-cleanup" });

async function main(): Promise<void> {
  const now = new Date().toISOString();
  log.info("token-cleanup starting", { now });

  const result = await cleanupExpiredTokens(now);

  log.info("token-cleanup done", { ...result });
  // eslint-disable-next-line no-console
  console.log("\nResult:", JSON.stringify(result, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    log.error("token-cleanup crashed", { err });
    process.exit(1);
  },
);
