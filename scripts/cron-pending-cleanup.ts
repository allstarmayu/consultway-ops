/**
 * Local invocation script for the pending-row cleanup cron.
 *
 * Run via:
 *   pnpm cron:pending-cleanup
 *
 * What it does:
 *   - Loads `.env.local` via dotenv/config.
 *   - Calls `runPendingCleanup` against the local SQLite with the
 *     default 60-minute age cutoff.
 *   - Prints the result summary + exits cleanly.
 *
 * Production note: same as `cron-expiry-sweep.ts` - this is a local
 * convenience. The Cloudflare scheduled handler will replace it in
 * production when deployment-wiring lands.
 *
 * @module scripts/cron-pending-cleanup
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { runPendingCleanup } from "@/lib/documents/crons/pending-cleanup";

const log = logger.child({ module: "cron-pending-cleanup" });

async function main(): Promise<void> {
  const now = new Date().toISOString();
  log.info("pending-cleanup starting", { now });

  const result = await runPendingCleanup({
    db,
    logger: log,
    now,
  });

  log.info("pending-cleanup done", { ...result });
  // eslint-disable-next-line no-console
  console.log("\nResult:", JSON.stringify(result, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    log.error("pending-cleanup crashed", { err });
    process.exit(1);
  },
);
