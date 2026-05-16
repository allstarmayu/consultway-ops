/**
 * Database seed script.
 *
 * Creates baseline data every Consultway environment needs:
 *
 *   Users:
 *     - admin@consultway.local (role: admin, password: ChangeMe123!)
 *     - staff@consultway.local (role: staff, password: ChangeMe123!)
 *
 *   Companies:
 *     - Three standalone companies covering different sectors / geographies
 *       / compliance states.
 *     - Two joint ventures whose `parentCompanyIds` reference two of the
 *       standalones above. JVs are inserted AFTER their parents exist so
 *       the UUIDs can be looked up.
 *
 * Idempotent: running twice won't crash or create duplicates — it checks
 * for existing rows by email (users) or name (companies) and skips
 * seeding if found. Safe to run after a `db:migrate` or fresh clone.
 *
 * Usage:  pnpm db:seed
 *
 * Node-only. Connects to the local SQLite file directly via lib/db —
 * never run this against production.
 *
 * @module scripts/seed
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  type NewUser,
  type NewCompany,
  type ComplianceStatus,
} from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "seed" });

// ── User seeds ──────────────────────────────────────────────────────────────

/**
 * Baseline users. Passwords match across both so dev can log in with
 * the obvious credential. Production MUST change these.
 */
const SEED_USERS: Array<
  Omit<NewUser, "id" | "passwordHash"> & { plaintextPassword: string }
> = [
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

// ── Company seeds ───────────────────────────────────────────────────────────

/**
 * Shape for a standalone company seed — no parent linkage needed.
 * The `id` is generated at insert time; everything else is declared.
 *
 * Why a separate type from `NewCompany`: NewCompany requires `id` and
 * also lets you pass `parentCompanyIds`. For standalone companies we
 * want neither — id is generated, partners are always null. This type
 * makes that contract explicit.
 */
type StandaloneSeed = Omit<
  NewCompany,
  "id" | "isJv" | "parentCompanyIds" | "complianceStatus"
> & {
  complianceStatus: ComplianceStatus;
};

/**
 * Three standalone companies. Different sectors, different geographies,
 * different compliance states — so the figma's filter UI can be tried
 * end-to-end against real(ish) data.
 *
 * GST/PAN values follow the official Indian formats (15 chars GST, 10
 * chars PAN, with PAN embedded in GST positions 3-12) and pass the Zod
 * regex in lib/companies/schemas.ts. They're not real registered values.
 */
const STANDALONE_COMPANIES: StandaloneSeed[] = [
  {
    name: "Acme Construction Pvt Ltd",
    sector: "Infrastructure",
    geography: "Pan India",
    gstNumber: "27ABCDE1234F1Z5",
    panNumber: "ABCDE1234F",
    isMsme: true,
    complianceStatus: "compliant",
    contactEmail: "info@acmeconstruction.example",
    contactPhone: "+91 22 5550 1100",
    contactPersonName: "Rohan Mehta",
    addressLine: "Plot 14, MIDC Industrial Area",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400093",
    internalNotes:
      "Long-standing partner. Strong execution on highway and metro projects.",
  },
  {
    name: "BuildRight Engineers",
    sector: "Civil Works",
    geography: "North India",
    gstNumber: "07XYZAB5678P1Z3",
    panNumber: "XYZAB5678P",
    isMsme: false,
    complianceStatus: "compliant",
    contactEmail: "contact@buildrighteng.example",
    contactPhone: "+91 11 4022 3300",
    contactPersonName: "Priya Sharma",
    addressLine: "Tower B, DLF Cyber City",
    city: "Gurugram",
    state: "Haryana",
    pincode: "122002",
    internalNotes:
      "Specialises in bridges and elevated corridors. Documents up to date as of last audit.",
  },
  {
    name: "GreenTech Solutions",
    sector: "IT Services",
    geography: "Karnataka",
    gstNumber: "29PQRST9012M1Z7",
    panNumber: "PQRST9012M",
    isMsme: true,
    complianceStatus: "pending",
    contactEmail: "hello@greentechsol.example",
    contactPhone: "+91 80 4150 8800",
    contactPersonName: "Arjun Iyer",
    addressLine: "WeWork Galaxy, Residency Road",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560025",
    internalNotes:
      "New registration. Awaiting GST verification document upload.",
  },
];

/**
 * Joint ventures reference parent companies by NAME at seed time, then
 * the script resolves those names to UUIDs (the actual `parent_company_ids`
 * column stores UUIDs, not names — names are just a seed-time convenience
 * so this file stays readable).
 */
interface JvSeed
  extends Omit<
    NewCompany,
    "id" | "isJv" | "parentCompanyIds" | "complianceStatus"
  > {
  /** Names of the standalone companies that partner in this JV. */
  partnerNames: string[];
  complianceStatus: ComplianceStatus;
}

const JV_COMPANIES: JvSeed[] = [
  {
    name: "Acme-BuildRight JV",
    sector: "Infrastructure",
    geography: "Pan India",
    gstNumber: "27JVPAN1234A1Z2",
    panNumber: "JVPAN1234A",
    isMsme: false,
    complianceStatus: "compliant",
    contactEmail: "ops@acme-buildright.example",
    contactPhone: "+91 22 5560 2200",
    contactPersonName: "Vikram Joshi",
    addressLine: "Joint Venture Office, BKC",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400051",
    internalNotes:
      "Formed for the Coastal Road Project consortium. Three-year initial term.",
    partnerNames: ["Acme Construction Pvt Ltd", "BuildRight Engineers"],
  },
  {
    name: "Modern-Alpha Alliance",
    sector: "Roads & Highways",
    geography: "Maharashtra",
    gstNumber: "27JVPAN5678B1Z9",
    panNumber: "JVPAN5678B",
    isMsme: false,
    complianceStatus: "non_compliant",
    contactEmail: "office@modernalpha.example",
    contactPhone: "+91 22 5570 4400",
    contactPersonName: "Anita Deshmukh",
    addressLine: "Andheri East",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400069",
    internalNotes:
      "Compliance flagged — environmental clearance documents lapsed. Follow-up pending.",
    partnerNames: ["GreenTech Solutions", "BuildRight Engineers"],
  },
];

// ── Seeding helpers ─────────────────────────────────────────────────────────

/**
 * Seed one user. Returns whether it was created or skipped.
 */
async function seedUser(
  spec: (typeof SEED_USERS)[number],
): Promise<"created" | "skipped"> {
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

/**
 * Seed one standalone company. Idempotency check is by `name` —
 * pragmatic for a dev seed (the company name is human-meaningful and
 * unique in our seed set). Production datasets use the unique GST/PAN
 * constraints instead, but those are nullable in seed data so name is
 * the better key here.
 */
async function seedStandaloneCompany(
  spec: StandaloneSeed,
): Promise<"created" | "skipped"> {
  const existing = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, spec.name))
    .limit(1);

  if (existing.length > 0) {
    log.info("company already exists, skipping", { name: spec.name });
    return "skipped";
  }

  await db.insert(companies).values({
    id: newId(),
    name: spec.name,
    sector: spec.sector,
    geography: spec.geography,
    gstNumber: spec.gstNumber,
    panNumber: spec.panNumber,
    isMsme: spec.isMsme,
    isJv: false,
    complianceStatus: spec.complianceStatus,
    parentCompanyIds: null,
    contactEmail: spec.contactEmail,
    contactPhone: spec.contactPhone,
    contactPersonName: spec.contactPersonName,
    addressLine: spec.addressLine,
    city: spec.city,
    state: spec.state,
    pincode: spec.pincode,
    internalNotes: spec.internalNotes,
  });

  log.info("seeded company", { name: spec.name, sector: spec.sector });
  return "created";
}

/**
 * Seed one JV. Looks up each partner by name, fails loudly if any
 * partner doesn't exist (would mean the standalones didn't seed,
 * which is itself a bug worth surfacing).
 */
async function seedJvCompany(
  spec: JvSeed,
): Promise<"created" | "skipped"> {
  const existing = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, spec.name))
    .limit(1);

  if (existing.length > 0) {
    log.info("JV already exists, skipping", { name: spec.name });
    return "skipped";
  }

  // Resolve partner names → UUIDs. Use sequential awaits rather than
  // Promise.all because we want clearer error messages if one partner
  // is missing (knowing WHICH partner failed matters during debugging).
  const partnerIds: string[] = [];
  for (const partnerName of spec.partnerNames) {
    const partner = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.name, partnerName))
      .limit(1)
      .then((rows) => rows[0]);

    if (!partner) {
      throw new Error(
        `JV "${spec.name}" references partner "${partnerName}" but no such company exists. Did the standalone seeds run first?`,
      );
    }
    partnerIds.push(partner.id);
  }

  await db.insert(companies).values({
    id: newId(),
    name: spec.name,
    sector: spec.sector,
    geography: spec.geography,
    gstNumber: spec.gstNumber,
    panNumber: spec.panNumber,
    isMsme: spec.isMsme,
    isJv: true,
    complianceStatus: spec.complianceStatus,
    parentCompanyIds: partnerIds,
    contactEmail: spec.contactEmail,
    contactPhone: spec.contactPhone,
    contactPersonName: spec.contactPersonName,
    addressLine: spec.addressLine,
    city: spec.city,
    state: spec.state,
    pincode: spec.pincode,
    internalNotes: spec.internalNotes,
  });

  log.info("seeded JV", {
    name: spec.name,
    partnerCount: partnerIds.length,
  });
  return "created";
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("starting seed");

  const stats = { created: 0, skipped: 0 };
  const bump = (r: "created" | "skipped") => {
    stats[r]++;
  };

  // 1. Users first — independent of companies.
  for (const spec of SEED_USERS) {
    bump(await seedUser(spec));
  }

  // 2. Standalone companies — must exist before JVs that reference them.
  for (const spec of STANDALONE_COMPANIES) {
    bump(await seedStandaloneCompany(spec));
  }

  // 3. JVs last — they look up their partners by name.
  for (const spec of JV_COMPANIES) {
    bump(await seedJvCompany(spec));
  }

  const total =
    SEED_USERS.length + STANDALONE_COMPANIES.length + JV_COMPANIES.length;

  log.info("seed complete", {
    created: stats.created,
    skipped: stats.skipped,
    total,
  });

  // Close the SQLite connection so the script exits cleanly. Without
  // this, the process hangs on the open file handle.
  const { default: Database } = await import("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite = (globalThis as any).__sqlite as
    | InstanceType<typeof Database>
    | undefined;
  sqlite?.close();
}

main().catch((err) => {
  log.error("seed failed", { err });
  process.exit(1);
});
