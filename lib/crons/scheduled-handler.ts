/**
 * Cloudflare-side scheduled() entry point for the daily crons.
 *
 * The platform invokes this function once per matching trigger in
 * `wrangler.jsonc`'s `triggers.crons` list:
 *
 *   - `0 2 * * *` → document expiry sweep (`runExpirySweep`)
 *   - `0 3 * * *` → pending-row cleanup (`runPendingCleanup`)
 *   - `0 4 * * *` → expired-token cleanup (`cleanupExpiredTokens`,
 *     covers both `email_verification_tokens` and
 *     `password_reset_tokens`)
 *
 * The cron string is dispatched on so a single worker entry handles
 * all three schedules. Adding a fourth trigger is a matter of one more
 * case in the `switch` plus the corresponding `wrangler.jsonc` entry.
 *
 * Failure model:
 *   Cloudflare's scheduled handler treats a thrown error as a failed
 *   invocation, which surfaces in the dashboard and (depending on
 *   notification config) can page someone. Our cron handlers already
 *   report results through their structured `Result` types and write
 *   per-row errors to the logger; the handler swallowing a top-level
 *   throw keeps a partial failure from masquerading as a worker-level
 *   crash. The logged error is the forensic trail.
 *
 * Local mirror:
 *   `scripts/cron-expiry-sweep.ts` and `scripts/cron-pending-cleanup.ts`
 *   build the exact same `Deps` shape used here, so a local invocation
 *   (`pnpm cron:expiry-sweep` / `pnpm cron:pending-cleanup`) exercises
 *   the same code path the scheduled handler eventually does in
 *   production.
 *
 * @module lib/crons/scheduled-handler
 */
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email/client";
import { runExpirySweep } from "@/lib/documents/crons/expiry-sweep";
import { runPendingCleanup } from "@/lib/documents/crons/pending-cleanup";
import { cleanupExpiredTokens } from "@/lib/auth/tokens";

const log = logger.child({ module: "scheduled-handler" });

/**
 * Subset of Cloudflare's `ScheduledEvent` we actually use. Typed locally
 * so this module doesn't depend on `@cloudflare/workers-types` at the
 * file level (the rest of the repo doesn't import that either; runtime
 * shape is what matters).
 */
export interface ScheduledArgs {
  /** The cron string from `wrangler.jsonc` that fired this invocation. */
  cron: string;
  /** Unix epoch ms — when the platform decided to invoke. */
  scheduledTime: number;
}

/**
 * Cron pattern → handler dispatch table.
 *
 * Kept as string-literal constants so the switch can compare against
 * them statically and a typo would be a TypeScript error rather than
 * a silent "unknown cron" branch.
 */
const CRON_EXPIRY_SWEEP = "0 2 * * *" as const;
const CRON_PENDING_CLEANUP = "0 3 * * *" as const;
const CRON_TOKEN_CLEANUP = "0 4 * * *" as const;

/**
 * Cloudflare scheduled() entry. Invoked by the platform on each cron
 * trigger; never invoked from app code. Production wiring lives in the
 * worker entrypoint that OpenNext generates — see `open-next.config.*`
 * for the export hook.
 *
 * Returns `void` to match Cloudflare's `ScheduledEvent` handler contract.
 * Awaited internally so a logged "complete" line lands after the work
 * actually finishes.
 */
export async function scheduled(args: ScheduledArgs): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const startedAt = Date.now();
  log.info("scheduled invocation start", {
    cron: args.cron,
    scheduledTime: args.scheduledTime,
    today,
  });

  try {
    switch (args.cron) {
      case CRON_EXPIRY_SWEEP: {
        const result = await runExpirySweep({
          db,
          logger: log,
          sendEmail,
          appUrl: env.NEXT_PUBLIC_APP_URL,
          today,
        });
        log.info("scheduled expiry-sweep done", {
          cron: args.cron,
          durationMs: Date.now() - startedAt,
          ...result,
        });
        return;
      }

      case CRON_PENDING_CLEANUP: {
        const now = new Date().toISOString();
        const result = await runPendingCleanup({
          db,
          logger: log,
          now,
        });
        log.info("scheduled pending-cleanup done", {
          cron: args.cron,
          durationMs: Date.now() - startedAt,
          ...result,
        });
        return;
      }

      case CRON_TOKEN_CLEANUP: {
        // Sweep expired email-verification + password-reset tokens out
        // of their two tables. The helper is shared with
        // `scripts/cron-token-cleanup.ts` (local invocation) so the
        // same code path runs in both environments.
        const now = new Date().toISOString();
        const result = await cleanupExpiredTokens(now);
        log.info("scheduled token-cleanup done", {
          cron: args.cron,
          durationMs: Date.now() - startedAt,
          ...result,
        });
        return;
      }

      default: {
        log.warn("scheduled invocation with unknown cron - no-op", {
          cron: args.cron,
          scheduledTime: args.scheduledTime,
        });
        return;
      }
    }
  } catch (err) {
    // Swallow and log. Throwing here would mark the invocation as failed
    // in the Cloudflare dashboard; our handlers already log per-row
    // outcomes and return structured results, so a top-level throw would
    // double-count as both a per-row error AND a worker failure. Logging
    // here preserves the forensic trail without paging.
    log.error("scheduled handler crashed", {
      err,
      cron: args.cron,
      scheduledTime: args.scheduledTime,
      durationMs: Date.now() - startedAt,
    });
  }
}
