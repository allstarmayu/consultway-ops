/**
 * Local SQLite reset — wipes the dev DB file (and its WAL/SHM siblings)
 * so the next `pnpm db:migrate && pnpm db:seed` rebuilds from scratch.
 *
 * Invoked as the first step of `pnpm db:reset`:
 *
 *   tsx scripts/reset-db.ts && pnpm db:migrate && pnpm db:seed
 *
 * Three layered safety guards before any unlink happens, because
 * "delete the DB" is the kind of script you wish had said no to you
 * exactly once:
 *
 *   1. **NODE_ENV gate.** Refuses to run when NODE_ENV=production.
 *      The dev DB lives outside of production anyway, but a `wrangler
 *      d1 execute --remote` (or similar) muscle-memory mistake should
 *      not be one keystroke away from wiping anything.
 *
 *   2. **Path gate.** The target file must resolve under the project's
 *      `.wrangler/` directory. The default DATABASE_URL points there
 *      (`./.wrangler/consultway-local.sqlite`); a developer who's
 *      pointed DATABASE_URL elsewhere (e.g. a checked-in fixture, a
 *      shared dev DB) won't have it inside `.wrangler/` and the script
 *      bails. Better an annoying re-pointing than an irrecoverable
 *      delete.
 *
 *   3. **Path resolution.** Uses `path.resolve` + a startsWith check
 *      against the resolved `.wrangler` directory so a sneaky relative
 *      DATABASE_URL like `./.wrangler/../foo.sqlite` can't escape.
 *
 * Companion siblings (`.sqlite-wal`, `.sqlite-shm`) are removed too.
 * Leaving them behind on a wipe is a known footgun — better-sqlite3
 * happily reopens a deleted DB by replaying the WAL, undoing the wipe.
 *
 * The actual migration + seed steps run as separate processes via the
 * `pnpm db:reset` script chain so each one's own logging / exit codes
 * remain unchanged.
 *
 * @module scripts/reset-db
 */
import "dotenv/config";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "reset-db" });

function fail(reason: string): never {
  log.error("refusing to reset", { reason });
  process.exit(1);
}

function main(): void {
  // ── Guard 1: NODE_ENV gate ────────────────────────────────────────────
  if (env.NODE_ENV === "production") {
    fail(
      "NODE_ENV=production — refusing to wipe DB. This script is dev-only.",
    );
  }

  const targetPath = resolve(env.DATABASE_URL);
  const wranglerDir = resolve(".wrangler");

  log.info("resolved paths", {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    targetPath,
    wranglerDir,
  });

  // ── Guard 2 + 3: path containment check ───────────────────────────────
  // The resolved target must sit somewhere under .wrangler/. This blocks
  // both an env-pointed DATABASE_URL outside the dir and a path-traversal
  // pattern like ./.wrangler/../something.sqlite.
  const wranglerWithSep = wranglerDir.endsWith("\\") || wranglerDir.endsWith("/")
    ? wranglerDir
    : `${wranglerDir}${process.platform === "win32" ? "\\" : "/"}`;
  if (!targetPath.startsWith(wranglerWithSep)) {
    fail(
      `Refusing to delete DB outside .wrangler/. Resolved target was: ${targetPath}`,
    );
  }

  // Sanity-check parent dir exists. If the file's gone but the directory
  // is also missing, there's nothing to do — exit successfully so the
  // chained migrate+seed can proceed against a fresh DB.
  if (!existsSync(dirname(targetPath))) {
    log.info("wrangler dir absent — nothing to delete", {
      dir: dirname(targetPath),
    });
    return;
  }

  // ── Delete the main DB + WAL/SHM siblings ─────────────────────────────
  // better-sqlite3 in WAL mode (our dev pragma) writes alongside the
  // main file. Leaving either sibling behind can let a reopen replay
  // and resurrect the data you thought you wiped.
  const candidates = [
    targetPath,
    `${targetPath}-wal`,
    `${targetPath}-shm`,
  ];

  let deleted = 0;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      unlinkSync(file);
      log.info("deleted", { file });
      deleted++;
    } catch (err) {
      // EBUSY on Windows almost always means a long-running process
      // (most commonly `pnpm dev` / `next dev`) holds a SQLite handle
      // via lib/db. Same on Linux/macOS as EACCES on a flock'd file.
      // Surface a directly actionable hint instead of a raw fs error.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
        fail(
          `Could not delete ${file} (${code}). Another process is holding the DB open. Stop \`pnpm dev\` (or \`pnpm db:studio\`) and try again.`,
        );
      }
      throw err;
    }
  }

  if (deleted === 0) {
    log.info("no files to delete — already clean");
  } else {
    log.info("reset complete", { deletedCount: deleted });
  }
}

try {
  main();
} catch (err) {
  log.error("reset failed", { err });
  process.exit(1);
}
