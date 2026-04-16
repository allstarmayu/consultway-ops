/**
 * Database seed script.
 *
 * Creates the two baseline users every Consultway environment needs:
 *   - admin@consultway.local (role: admin)
 *   - staff@consultway.local (role: staff)
 *
 * Idempotent: running twice won't crash or create duplicates — it
 * checks for existing rows by email and skips seeding if found.
 * Safe to run on every fresh-clone or after a `db:migrate`.
 *
 * Usage:  pnpm db:seed
 *
 * This script is Node-only. It imports `lib/db` which connects to the
 * local SQLite file directly — never run this against production.
 *
 * @module scripts/seed
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, type NewUser } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "seed" });

/**
 * Users to seed. Passwords are the same ("ChangeMe123!") so both
 * accounts can log in with the obvious dev credential.
 *
 * Production MUST change these before going live — the login page
 * should ideally show a warning banner if either of these rows still
 * has the default hash.
 */
const SEED_USERS: Array<Omit<NewUser, "id" | "passwordHash"> & { plaintextPassword: string }> = [
  {
    email: "admin@consultway.local",
    name: "Consultway Admin",
    role: "admin",
    companyId: null,
    isActive: true,
    emailVerifiedAt: new Date().toISOString(),
    plaintextPassword: "ChangeMe123!",
  },
  {
    email: "staff@consultway.local",
    name: "Consultway Staff",
    role: "staff",
    companyId: null,
    isActive: true,
    emailVerifiedAt: new Date().toISOString(),
    plaintextPassword: "ChangeMe123!",
  },
];

async function seedUser(
  spec: (typeof SEED_USERS)[number],
): Promise<"created" | "skipped"> {
  // Idempotency check — if a user with this email already exists, skip.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, spec.email))
    .limit(1);

  if (existing.length > 0) {
    log.info("user already exists, skipping", { email: spec.email });
    return "skipped";
  }

  const passwordHash = await hashPassword(spec.plaintextPassword);

  await db.insert(users).values({
    id: newId(),
    email: spec.email,
    passwordHash,
    role: spec.role,
    companyId: spec.companyId,
    name: spec.name,
    isActive: spec.isActive,
    emailVerifiedAt: spec.emailVerifiedAt,
  });

  log.info("seeded user", { email: spec.email, role: spec.role });
  return "created";
}

async function main(): Promise<void> {
  log.info("starting seed");

  let created = 0;
  let skipped = 0;

  for (const spec of SEED_USERS) {
    const result = await seedUser(spec);
    if (result === "created") created++;
    else skipped++;
  }

  log.info("seed complete", {
    created,
    skipped,
    total: SEED_USERS.length,
  });

  // Close the SQLite connection so the script exits cleanly.
  // Without this, the process hangs on the open file handle.
  const { default: Database } = await import("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite = (globalThis as any).__sqlite as InstanceType<
    typeof Database
  > | undefined;
  sqlite?.close();
}

main().catch((err) => {
  log.error("seed failed", { err });
  process.exit(1);
});
