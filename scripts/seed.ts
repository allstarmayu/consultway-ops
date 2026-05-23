/**
 * Seed script — populates the local SQLite DB with a baseline dataset
 * for development and demos.
 *
 * What gets seeded:
 *   1. The two default Consultway users (admin@consultway.local,
 *      staff@consultway.local). Both have `companyId: null` since
 *      Consultway staff don't belong to any client company.
 *   2. The Consultway Infotech sentinel company — used as the publisher
 *      FK target for internal tenders.
 *   3. Five standalone client companies covering the three primary
 *      compliance states.
 *   4. Two joint ventures wired up by partner-name lookup.
 *   5. A company-role test user (acme@example.local) linked to
 *      "Acme Construction Pvt Ltd" — used for testing the apply-to-
 *      tender flow end-to-end. Seeded AFTER companies because we need
 *      Acme's UUID to populate the user's companyId.
 *
 * Every step is idempotent — running `pnpm db:seed` against an already-
 * seeded DB skips existing rows and logs them as "skipped." Safe to re-run
 * after a `db:push` that didn't reset the DB.
 *
 * Cloudflare D1 note: this script targets the local better-sqlite3 driver
 * (see lib/db/index.ts). It is not designed to run against a remote D1
 * database — for that we'd use `wrangler d1 execute --remote` against a
 * dedicated production seed SQL file.
 *
 * @module scripts/seed
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  documents,
  type ComplianceStatus,
  type DocumentStatus,
  type DocumentType,
  type NewCompany,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { hashPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "seed" });

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Name of the Consultway Infotech sentinel company row. Used as the
 * publisher FK target for internal tenders. Kept as a constant so the
 * tenders module can import it without hard-coding the string in two
 * places. (When the tenders seed lands, we'll re-export this from a
 * shared module and have both files reference one source of truth.)
 */
export const CONSULTWAY_PUBLISHER_NAME = "Consultway Infotech";

// ── Seed data: Consultway staff users (no company link) ───────────────────

interface StaffUserSeed {
  email: string;
  plaintextPassword: string;
  role: UserRole;
  name: string;
  isActive: boolean;
  emailVerifiedAt: string | null;
}

const SEED_STAFF_USERS: StaffUserSeed[] = [
  {
    email: "admin@consultway.local",
    plaintextPassword: "ChangeMe123!",
    role: "admin",
    name: "Consultway Admin",
    isActive: true,
    emailVerifiedAt: new Date().toISOString(),
  },
  {
    email: "staff@consultway.local",
    plaintextPassword: "ChangeMe123!",
    role: "staff",
    name: "Consultway Staff",
    isActive: true,
    emailVerifiedAt: new Date().toISOString(),
  },
];

// ── Seed data: company-role test users (linked to a client company) ───────

/**
 * Company-role users are seeded AFTER companies — we need the target
 * company's UUID to populate `companyId`. The seed resolves the company
 * by name at seed time, same way JV partner refs work.
 *
 * Each entry below specifies the company NAME, not the UUID. The
 * seeder looks it up. Fails loudly if the named company doesn't exist
 * (would mean the standalones didn't seed, which is itself a bug).
 */
interface CompanyUserSeed {
  email: string;
  plaintextPassword: string;
  name: string;
  /** Name of the company this user belongs to. Resolved to UUID. */
  companyName: string;
  isActive: boolean;
  emailVerifiedAt: string | null;
}

const SEED_COMPANY_USERS: CompanyUserSeed[] = [
  {
    email: "acme@example.local",
    plaintextPassword: "ChangeMe123!",
    name: "Rajesh Patel (Acme)",
    companyName: "Acme Construction Pvt Ltd",
    isActive: true,
    emailVerifiedAt: new Date().toISOString(),
  },
];

// ── Seed data: standalone companies ───────────────────────────────────────

/**
 * Shape used for the standalone (non-JV) company seeds below. Mirrors
 * `NewCompany` minus the columns the seed script sets itself (`id`,
 * `isJv`, `parentCompanyIds`).
 */
type StandaloneSeed = Omit<NewCompany, "id" | "isJv" | "parentCompanyIds"> & {
  complianceStatus: ComplianceStatus;
};

const STANDALONE_COMPANIES: StandaloneSeed[] = [
  {
    name: "Acme Construction Pvt Ltd",
    sector: "Infrastructure",
    geography: "Maharashtra",
    gstNumber: "27AAACA1234A1Z5",
    panNumber: "AAACA1234A",
    isMsme: false,
    complianceStatus: "compliant",
    contactEmail: "contact@acme-construction.example",
    contactPhone: "+91 22 5550 1100",
    contactPersonName: "Rajesh Patel",
    addressLine: "Plot 12, Andheri Industrial Estate",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400093",
    internalNotes:
      "Strong track record on metro rail projects. Verified financials Q1 2026.",
  },
  {
    name: "BuildRight Engineers",
    sector: "Civil Works",
    geography: "Karnataka",
    gstNumber: "29AABCB5678B2Z6",
    panNumber: "AABCB5678B",
    isMsme: true,
    complianceStatus: "compliant",
    contactEmail: "hello@buildright.example",
    contactPhone: "+91 80 4040 2200",
    contactPersonName: "Priya Iyer",
    addressLine: "Brigade Tech Park, Whitefield",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560066",
    internalNotes:
      "MSME-certified, qualifies for reserved tenders. Strong on water infrastructure.",
  },
  {
    name: "GreenTech Solutions",
    sector: "Solar EPC",
    geography: "Tamil Nadu",
    gstNumber: "33AACCG9012C1Z3",
    panNumber: "AACCG9012C",
    isMsme: false,
    complianceStatus: "pending",
    contactEmail: "ops@greentech.example",
    contactPhone: "+91 44 4040 3300",
    contactPersonName: "Karthik Subramaniam",
    addressLine: "OMR Tech Boulevard, Sholinganallur",
    city: "Chennai",
    state: "Tamil Nadu",
    pincode: "600119",
    internalNotes:
      "Onboarding paperwork in review. Awaiting GST verification callback.",
  },
];

// ── Seed data: joint ventures ─────────────────────────────────────────────

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

// ── Seed data: documents per company ───────────────────────────────────────

/**
 * Document fixtures keyed by company name. Each company gets 3-5 docs
 * covering a realistic spread of types, statuses, and expiry profiles
 * so the documents section, the filter dropdowns, the side-sheet, and
 * the review affordances all have something to show on a fresh seed.
 *
 * `file_key` points at R2 keys that don't exist - these are demo-only
 * metadata rows. Downloading any of them will surface an R2 404; the
 * rest of the UI (list / detail sheet / verify / reject / filter)
 * works against the metadata alone. Flagged in the Day 11 report;
 * a future "stage real fixtures into R2" task could swap these for
 * actual blobs.
 *
 * `uploaderEmail` and `reviewerEmail` are resolved to UUIDs at seed
 * time. Using emails (not UUIDs) keeps the fixtures readable in this
 * file and decoupled from `newId()`'s output.
 */
interface DocumentSeed {
  documentType: DocumentType;
  fileName: string;
  status: DocumentStatus;
  /** Bytes. Realistic for the type (PDF certs ~150 KB, image scans ~1 MB). */
  sizeBytes: number;
  mimeType: "application/pdf" | "image/png" | "image/jpeg";
  /** ISO date YYYY-MM-DD; null = unknown. */
  issuedOn: string | null;
  /**
   * Relative to "today" at seed time. Null = no expiry; negative = past;
   * positive = future. Lets the seed stay date-independent.
   */
  expiresInDays: number | null;
  /** Email of the seeded user who uploaded this document. */
  uploaderEmail: string;
  /** Email of the seeded admin/staff user who reviewed. NULL = no review yet. */
  reviewerEmail: string | null;
  /** Optional reviewer notes (verified or rejected commentary). */
  reviewNotes: string | null;
}

/**
 * One fixtures block per company name. Skipped companies (the
 * Consultway publisher sentinel; any company the seed grew beyond
 * this map) just don't get document rows - the section's empty state
 * exercises that case.
 */
const DOCUMENTS_PER_COMPANY: Record<string, DocumentSeed[]> = {
  "Acme Construction Pvt Ltd": [
    {
      documentType: "gst_certificate",
      fileName: "Acme-GST-Certificate-2024.pdf",
      status: "verified",
      sizeBytes: 187_000,
      mimeType: "application/pdf",
      issuedOn: "2024-04-01",
      expiresInDays: 280, // ~9 months out
      uploaderEmail: "acme@example.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: "Verified via GSTN portal lookup; matches CIN on file.",
    },
    {
      documentType: "pan_card",
      fileName: "Acme-PAN-Card.pdf",
      status: "verified",
      sizeBytes: 92_000,
      mimeType: "application/pdf",
      issuedOn: "2019-08-12",
      expiresInDays: null, // PAN cards don't expire
      uploaderEmail: "acme@example.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "incorporation_cert",
      fileName: "Acme-CoI.pdf",
      status: "verified",
      sizeBytes: 354_000,
      mimeType: "application/pdf",
      issuedOn: "2019-08-01",
      expiresInDays: null,
      uploaderEmail: "acme@example.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "trade_license",
      fileName: "Acme-Mumbai-Trade-License.pdf",
      status: "verified",
      sizeBytes: 245_000,
      mimeType: "application/pdf",
      issuedOn: "2025-01-15",
      expiresInDays: 18, // near expiry - exercises the warning affordance
      uploaderEmail: "acme@example.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "board_resolution",
      fileName: "Acme-Board-Resolution-Coastal-Road.pdf",
      status: "pending_review",
      sizeBytes: 423_000,
      mimeType: "application/pdf",
      issuedOn: "2026-04-22",
      expiresInDays: null,
      uploaderEmail: "acme@example.local",
      reviewerEmail: null,
      reviewNotes: null,
    },
  ],
  "BuildRight Engineers": [
    {
      documentType: "gst_certificate",
      fileName: "BuildRight-GST.pdf",
      status: "verified",
      sizeBytes: 198_000,
      mimeType: "application/pdf",
      issuedOn: "2022-06-10",
      expiresInDays: 410,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "pan_card",
      fileName: "BuildRight-PAN.pdf",
      status: "verified",
      sizeBytes: 88_000,
      mimeType: "application/pdf",
      issuedOn: "2017-03-20",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "trade_license",
      fileName: "BuildRight-Bengaluru-License.pdf",
      status: "expired",
      sizeBytes: 261_000,
      mimeType: "application/pdf",
      issuedOn: "2022-02-01",
      expiresInDays: -45, // already past expiry, cron flipped it
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: "Renewal pending with Karnataka SAGE office.",
    },
    {
      documentType: "cancelled_cheque",
      fileName: "BuildRight-Cheque-HDFC.jpg",
      status: "verified",
      sizeBytes: 1_148_000,
      mimeType: "image/jpeg",
      issuedOn: null,
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: null,
    },
  ],
  "GreenTech Solutions": [
    {
      documentType: "gst_certificate",
      fileName: "GreenTech-GST-Application-Receipt.pdf",
      status: "rejected",
      sizeBytes: 142_000,
      mimeType: "application/pdf",
      issuedOn: "2026-04-10",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes:
        "This is an application acknowledgement, not the GST certificate itself. Please upload the actual REG-06 form once GSTN issues it.",
    },
    {
      documentType: "pan_card",
      fileName: "GreenTech-PAN.pdf",
      status: "pending_review",
      sizeBytes: 96_000,
      mimeType: "application/pdf",
      issuedOn: "2024-11-05",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: null,
      reviewNotes: null,
    },
    {
      documentType: "incorporation_cert",
      fileName: "GreenTech-CoI.pdf",
      status: "verified",
      sizeBytes: 410_000,
      mimeType: "application/pdf",
      issuedOn: "2024-10-28",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: null,
    },
  ],
  "Acme-BuildRight JV": [
    {
      documentType: "incorporation_cert",
      fileName: "Acme-BuildRight-JV-Agreement.pdf",
      status: "verified",
      sizeBytes: 612_000,
      mimeType: "application/pdf",
      issuedOn: "2025-09-15",
      expiresInDays: null,
      uploaderEmail: "admin@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: "Three-year JV term, witnessed by both partner notaries.",
    },
    {
      documentType: "board_resolution",
      fileName: "Acme-BuildRight-JV-Authority.pdf",
      status: "verified",
      sizeBytes: 388_000,
      mimeType: "application/pdf",
      issuedOn: "2025-09-20",
      expiresInDays: null,
      uploaderEmail: "admin@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "gst_certificate",
      fileName: "Acme-BuildRight-JV-GST.pdf",
      status: "verified",
      sizeBytes: 205_000,
      mimeType: "application/pdf",
      issuedOn: "2025-10-01",
      expiresInDays: 215,
      uploaderEmail: "admin@consultway.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: null,
    },
  ],
  "Modern-Alpha Alliance": [
    {
      documentType: "gst_certificate",
      fileName: "ModernAlpha-GST.pdf",
      status: "verified",
      sizeBytes: 178_000,
      mimeType: "application/pdf",
      issuedOn: "2023-12-05",
      expiresInDays: 95,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "other",
      fileName: "ModernAlpha-Environmental-Clearance-LAPSED.pdf",
      status: "expired",
      sizeBytes: 524_000,
      mimeType: "application/pdf",
      issuedOn: "2022-03-01",
      expiresInDays: -120,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes:
        "Environmental clearance from MoEFCC lapsed. Renewal blocks any tender application until refiled.",
    },
    {
      documentType: "board_resolution",
      fileName: "ModernAlpha-Authority-2026.pdf",
      status: "rejected",
      sizeBytes: 312_000,
      mimeType: "application/pdf",
      issuedOn: "2026-02-14",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes:
        "Resolution signed by only one partner's authorised signatory. Both JV partners must sign per the JV deed. Re-upload after countersignature.",
    },
  ],
};

// ── Seeding helpers ───────────────────────────────────────────────────────

/**
 * Seed one Consultway staff user (admin or staff role, no company link).
 * Returns whether it was created or skipped.
 */
async function seedStaffUser(
  spec: StaffUserSeed,
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
    companyId: null,
    name: spec.name,
    isActive: spec.isActive,
    emailVerifiedAt: spec.emailVerifiedAt,
  });

  log.info("seeded user", { email: spec.email, role: spec.role });
  return "created";
}

/**
 * Seed one company-role user. Looks up the named company at insert
 * time so the user's `companyId` FK is real. Throws if the named
 * company doesn't exist — that would mean the standalone-companies
 * step didn't run first, which is a bug worth surfacing loudly.
 */
async function seedCompanyUser(
  spec: CompanyUserSeed,
): Promise<"created" | "skipped"> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, spec.email))
    .limit(1);

  if (existing.length > 0) {
    log.info("company user already exists, skipping", { email: spec.email });
    return "skipped";
  }

  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, spec.companyName))
    .limit(1)
    .then((rows) => rows[0]);

  if (!company) {
    throw new Error(
      `Company-role user "${spec.email}" references company "${spec.companyName}" but no such company exists. Did the standalone seeds run first?`,
    );
  }

  const passwordHash = await hashPassword(spec.plaintextPassword);

  await db.insert(users).values({
    id: newId(),
    email: spec.email,
    passwordHash,
    role: "company",
    companyId: company.id,
    name: spec.name,
    isActive: spec.isActive,
    emailVerifiedAt: spec.emailVerifiedAt,
  });

  log.info("seeded company user", {
    email: spec.email,
    companyName: spec.companyName,
  });
  return "created";
}

/**
 * Seed the Consultway Infotech sentinel company row.
 *
 * This row is the publisher FK target for internal tenders (tenders that
 * Consultway itself runs, as opposed to subcontract tenders published by
 * a real client company). Keeping it as a regular `companies` row means
 * the tenders schema only needs a single `publisherCompanyId` FK — no
 * special "is_internal" branch in queries.
 *
 * Idempotent by name. The row is marked compliant and as a non-MSME,
 * non-JV with placeholder identifiers — it's not a real registered
 * business but rather an internal sentinel, and the UI won't typically
 * show it in the public company roster (we'll add a filter exclusion in
 * the companies list when the tender-publish flow lands).
 */
async function seedConsultwayPublisher(): Promise<"created" | "skipped"> {
  const existing = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, CONSULTWAY_PUBLISHER_NAME))
    .limit(1);

  if (existing.length > 0) {
    log.info("Consultway publisher already exists, skipping", {
      name: CONSULTWAY_PUBLISHER_NAME,
    });
    return "skipped";
  }

  await db.insert(companies).values({
    id: newId(),
    name: CONSULTWAY_PUBLISHER_NAME,
    sector: "Consulting",
    geography: "Pan India",
    // No GST/PAN — this is an internal sentinel, not a registered org row.
    // Leaving these NULL avoids colliding with real company unique constraints.
    gstNumber: null,
    panNumber: null,
    isMsme: false,
    isJv: false,
    complianceStatus: "compliant",
    parentCompanyIds: null,
    contactEmail: "ops@consultway.local",
    contactPhone: null,
    contactPersonName: "Consultway Operations",
    addressLine: null,
    city: null,
    state: null,
    pincode: null,
    internalNotes:
      "Internal sentinel company. Used as the publisher of Consultway-run tenders. Do not delete.",
  });

  log.info("seeded Consultway publisher company", {
    name: CONSULTWAY_PUBLISHER_NAME,
  });
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

/**
 * Compute an ISO date `daysFromNow` away from "today" in UTC.
 * Negative values land in the past. Returns `null` if the input is null.
 */
function isoDateOffset(daysFromNow: number | null): string | null {
  if (daysFromNow === null) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/**
 * Seed one company's document fixtures. Idempotent on the
 * `(company_id, file_name)` pair - re-running this script against an
 * already-seeded DB skips existing rows without raising. Uploader and
 * reviewer emails are resolved to UUIDs; an unknown email fails loudly
 * with a clear message (would mean the earlier user-seeding step
 * didn't run).
 *
 * Returns the per-company tally of created and skipped rows.
 */
async function seedDocumentsForCompany(
  companyName: string,
  specs: DocumentSeed[],
): Promise<{ created: number; skipped: number }> {
  const tally = { created: 0, skipped: 0 };

  // Resolve the company id once per company.
  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, companyName))
    .limit(1)
    .then((rows) => rows[0]);

  if (!company) {
    log.warn("skipping document seed: company not found", { companyName });
    return tally;
  }

  // Resolve uploader/reviewer emails to UUIDs in a single batch up front.
  const uniqueEmails = Array.from(
    new Set(
      specs.flatMap((s) =>
        s.reviewerEmail ? [s.uploaderEmail, s.reviewerEmail] : [s.uploaderEmail],
      ),
    ),
  );

  const emailToId = new Map<string, string>();
  for (const email of uniqueEmails) {
    const u = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
      .then((rows) => rows[0]);
    if (!u) {
      throw new Error(
        `Document seed for "${companyName}" references user "${email}" but no such user exists. Did the user-seed step run first?`,
      );
    }
    emailToId.set(email, u.id);
  }

  for (const spec of specs) {
    // Idempotency check: (companyId, fileName) is unique enough for the
    // fixture set (we control these names; production rows can clash on
    // filename across companies but never within one).
    const existing = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, company.id),
          eq(documents.fileName, spec.fileName),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      tally.skipped++;
      continue;
    }

    const documentId = newId();
    const uploadedById = emailToId.get(spec.uploaderEmail)!;
    const reviewedById = spec.reviewerEmail
      ? emailToId.get(spec.reviewerEmail)!
      : null;

    // The reviewed_at stamp is only meaningful for terminal-review states.
    // `verified` / `rejected` always carry a reviewer + a timestamp;
    // `expired` rows are flipped by the cron from `verified`, so they
    // keep the original reviewer + add a (notional) review timestamp.
    const isReviewed =
      spec.status === "verified" ||
      spec.status === "rejected" ||
      spec.status === "expired";
    const reviewedAt = isReviewed ? new Date().toISOString() : null;

    await db.insert(documents).values({
      id: documentId,
      companyId: company.id,
      documentType: spec.documentType,
      // Demo metadata - bytes don't actually exist in R2. The fileKey
      // shape matches what `lib/r2/keys.ts::buildDocumentKey` produces
      // so the action layer's RBAC checks behave identically against
      // these rows.
      fileKey: `companies/${company.id}/${documentId}/${spec.fileName}`,
      fileName: spec.fileName,
      mimeType: spec.mimeType,
      sizeBytes: spec.sizeBytes,
      status: spec.status,
      reviewNotes: spec.reviewNotes,
      reviewedBy: reviewedById,
      reviewedAt,
      issuedOn: spec.issuedOn,
      expiresAt: isoDateOffset(spec.expiresInDays),
      uploadedBy: uploadedById,
      uploadedAt: new Date().toISOString(),
    });

    tally.created++;
  }

  log.info("seeded documents for company", {
    companyName,
    created: tally.created,
    skipped: tally.skipped,
  });

  return tally;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("starting seed");

  const stats = { created: 0, skipped: 0 };
  const bump = (r: "created" | "skipped") => {
    stats[r]++;
  };

  // 1. Consultway staff users first — independent of companies.
  for (const spec of SEED_STAFF_USERS) {
    bump(await seedStaffUser(spec));
  }

  // 2. Consultway publisher sentinel — must exist before any tender seed
  //    runs (when those land) since `tenders.publisherCompanyId` is NOT
  //    NULL. Ordered before client companies so the publisher row reliably
  //    has the lowest createdAt timestamp.
  bump(await seedConsultwayPublisher());

  // 3. Standalone companies — must exist before JVs that reference them.
  for (const spec of STANDALONE_COMPANIES) {
    bump(await seedStandaloneCompany(spec));
  }

  // 4. JVs — they look up their partners by name.
  for (const spec of JV_COMPANIES) {
    bump(await seedJvCompany(spec));
  }

  // 5. Company-role users — they reference a client company by name,
  //    so the named companies must exist by this point.
  for (const spec of SEED_COMPANY_USERS) {
    bump(await seedCompanyUser(spec));
  }

  // 6. Document fixtures LAST. Documents reference both a company
  //    (FK companyId) and users (FK uploadedBy, reviewedBy), so all
  //    earlier steps must have run. Tracked under a separate tally
  //    so the doc-level numbers are visible in the final log line.
  const docStats = { created: 0, skipped: 0 };
  for (const [companyName, specs] of Object.entries(DOCUMENTS_PER_COMPANY)) {
    const tally = await seedDocumentsForCompany(companyName, specs);
    docStats.created += tally.created;
    docStats.skipped += tally.skipped;
  }

  const total =
    SEED_STAFF_USERS.length +
    1 + // Consultway publisher
    STANDALONE_COMPANIES.length +
    JV_COMPANIES.length +
    SEED_COMPANY_USERS.length;

  const totalDocuments = Object.values(DOCUMENTS_PER_COMPANY).reduce(
    (sum, specs) => sum + specs.length,
    0,
  );

  log.info("seed complete", {
    created: stats.created,
    skipped: stats.skipped,
    total,
    documentsCreated: docStats.created,
    documentsSkipped: docStats.skipped,
    totalDocuments,
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
