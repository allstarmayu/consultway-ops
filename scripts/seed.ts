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
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  documents,
  tenders,
  tenderApplications,
  projects,
  transactions,
  remindersSent,
  type ComplianceStatus,
  type DocumentStatus,
  type DocumentType,
  type NewCompany,
  type ProjectStatus,
  type TenderApplicationStatus,
  type TenderStatus,
  type TransactionType,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { hashPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";
import { recordAuditEvent } from "@/lib/audit/log";

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

/**
 * Deterministic `emailVerifiedAt` timestamp for seeded verified users.
 *
 * Using `new Date().toISOString()` would recompute on every seed run,
 * which (with the Chunk-3 compare-and-update contract) would make
 * every verified user look "updated" on every re-run. A stable
 * constant means the column matches across runs and the diff is
 * empty for identical fixtures.
 *
 * The specific date is arbitrary — only the non-null shape matters
 * for "this account is verified" semantics. Picked early-2026 so the
 * timestamp predates any realistic UAT activity.
 */
export const SEED_VERIFIED_AT = "2026-01-01T00:00:00.000Z";

// ── Scale profile ─────────────────────────────────────────────────────────

/**
 * Available scale profiles for the seed. Drives how many rows each
 * Day-22 fixture generator emits. Selected via the `SEED_SCALE` env
 * var; defaults to `large` so the local demo dataset stays rich.
 *
 *   - `small`  — ~1/5 of the full coverage. CI-friendly. Useful when
 *                the dev DB needs to reset quickly between iterations.
 *   - `medium` — ~1/2 of the full coverage. The "warm laptop" default
 *                if `large` feels heavy on a constrained machine.
 *   - `large`  — full Day-22 plan. ~30 companies / ~120 docs / ~25
 *                tenders / ~60 apps / ~25 projects / ~250 transactions.
 *                The default; what `pnpm db:seed` lands.
 */
export type SeedScale = "small" | "medium" | "large";

export interface SeedScaleProfile {
  /** Target standalone-company count BEYOND the Day-21 seeded set. */
  companies: number;
  /** Target document count across all companies. */
  documents: number;
  /** Target tender count. */
  tenders: number;
  /** Target tender-application count. */
  tenderApplications: number;
  /** Target project count. */
  projects: number;
  /** Target transaction count. */
  transactions: number;
  /** Approximate `reminders_sent` row count. */
  reminders: number;
}

export const SEED_SCALE_PROFILES: Record<SeedScale, SeedScaleProfile> = {
  small: {
    companies: 6,
    documents: 24,
    tenders: 5,
    tenderApplications: 12,
    projects: 5,
    transactions: 50,
    reminders: 2,
  },
  medium: {
    companies: 15,
    documents: 60,
    tenders: 12,
    tenderApplications: 30,
    projects: 12,
    transactions: 125,
    reminders: 3,
  },
  large: {
    companies: 30,
    documents: 120,
    tenders: 25,
    tenderApplications: 60,
    projects: 25,
    transactions: 250,
    reminders: 5,
  },
};

/**
 * Resolve the active scale from the `SEED_SCALE` env var.
 *
 * - Unset / empty → `large` (the default for local demos).
 * - Any other string is validated against the known profile keys;
 *   an unknown value throws loudly rather than silently degrading to
 *   default (better to surface a typo at the start of a 30s run than
 *   to land an unexpectedly small dataset).
 */
export function resolveSeedScale(raw: string | undefined = process.env.SEED_SCALE): SeedScale {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "large";
  if (value === "small" || value === "medium" || value === "large") return value;
  throw new Error(
    `Unknown SEED_SCALE=${JSON.stringify(raw)}. Expected one of: small, medium, large.`,
  );
}

// ── Seed data: Consultway staff users (no company link) ───────────────────

export interface StaffUserSeed {
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
    emailVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    email: "staff@consultway.local",
    plaintextPassword: "ChangeMe123!",
    role: "staff",
    name: "Consultway Staff",
    isActive: true,
    emailVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    // Second staff user — gives role-collision / "two staff workflows
    // colliding on the same row" tests a peer to point at, and lets the
    // audit feed show a non-singular actor on the staff side.
    email: "staff2@consultway.local",
    plaintextPassword: "ChangeMe123!",
    role: "staff",
    name: "Consultway Staff (Ops)",
    isActive: true,
    emailVerifiedAt: SEED_VERIFIED_AT,
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
export interface CompanyUserSeed {
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
    emailVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    // Second company-role user on a different company — exercises the
    // multi-company-user views (the audit feed, "all users at company X"
    // queries, the staff-side companies-list row counts).
    email: "buildright@example.local",
    plaintextPassword: "ChangeMe123!",
    name: "Priya Iyer (BuildRight)",
    companyName: "BuildRight Engineers",
    isActive: true,
    emailVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    // Third company-role user, on yet another company, with
    // emailVerifiedAt = null. Exercises the un-verified login gate
    // (`lib/auth/actions.ts::login` refuses unverified accounts) and
    // the "Resend verification email" affordance on the login surface
    // without anyone having to register a fresh account at demo time.
    email: "greentech@example.local",
    plaintextPassword: "ChangeMe123!",
    name: "Karthik Subramaniam (GreenTech)",
    companyName: "GreenTech Solutions",
    isActive: true,
    emailVerifiedAt: null,
  },
  {
    // Disabled account — exercises the deactivated-user UI affordance
    // (the login flow surfaces "account disabled" copy) and gives the
    // staff-side user roster a non-active row to render. Linked to a
    // brand-new company (Nimbus) so toggling this user's `isActive`
    // doesn't perturb any other test scenario.
    email: "inactive@example.local",
    plaintextPassword: "ChangeMe123!",
    name: "Disabled User (Nimbus)",
    companyName: "Nimbus Infraworks",
    isActive: false,
    emailVerifiedAt: SEED_VERIFIED_AT,
  },
];

// ── Seed data: standalone companies ───────────────────────────────────────

/**
 * Shape used for the standalone (non-JV) company seeds below. Mirrors
 * `NewCompany` minus the columns the seed script sets itself (`id`,
 * `isJv`, `parentCompanyIds`).
 */
export type StandaloneSeed = Omit<NewCompany, "id" | "isJv" | "parentCompanyIds"> & {
  complianceStatus: ComplianceStatus;
  /** Free-text reason populated when complianceStatus = 'rejected'. */
  rejectionReason?: string | null;
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
  {
    // Covers the `expired` complianceStatus value — that state is set
    // automatically by the nightly cron when a company's mandatory
    // documents lapse. Pairs with a stale GST document fixture below.
    // Annual turnover is set deliberately LOW (~₹2 crore) so the
    // turnover-eligibility gate (`applyToTender` vs
    // `tenders.minAnnualTurnoverInr`) gates this company out of every
    // realistically-sized tender in the Chunk 2 seed.
    name: "Vertex Power Systems",
    sector: "Solar EPC",
    geography: "Rajasthan",
    gstNumber: "08AAFCV4567D1Z2",
    panNumber: "AAFCV4567D",
    isMsme: false,
    complianceStatus: "expired",
    annualTurnover: 20_000_000, // ₹2 crore
    contactEmail: "ops@vertexpower.example",
    contactPhone: "+91 141 4040 5500",
    contactPersonName: "Suresh Mehta",
    addressLine: "Sitapura Industrial Area, Phase II",
    city: "Jaipur",
    state: "Rajasthan",
    pincode: "302022",
    internalNotes:
      "Trade license lapsed Q4 2025; complianceStatus rolled to expired by the nightly cron. Renewal documents pending submission.",
  },
  {
    // Covers the "well-resourced compliant company" axis. Annual
    // turnover set deliberately HIGH (₹100 crore) so this company
    // clears every reasonably-sized `minAnnualTurnoverInr` filter the
    // Chunk 2 tender fixtures set. Pairs with a `pending` document
    // fixture (the pre-confirm upload state) so the seed exercises
    // every DocumentStatus value.
    name: "Nimbus Infraworks",
    sector: "Infrastructure",
    geography: "Delhi NCR",
    gstNumber: "07AAGCN7890E1Z1",
    panNumber: "AAGCN7890E",
    isMsme: false,
    complianceStatus: "compliant",
    annualTurnover: 1_000_000_000, // ₹100 crore
    contactEmail: "ops@nimbusinfra.example",
    contactPhone: "+91 11 4040 6600",
    contactPersonName: "Aarav Khanna",
    addressLine: "DLF Cyber City, Tower B",
    city: "Gurugram",
    state: "Haryana",
    pincode: "122002",
    internalNotes:
      "Tier-1 EPC firm. Verified financials Q1 2026; turnover stated in audited filings. Cleared for high-value tender eligibility.",
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
export interface DocumentSeed {
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
      // Verified document close to expiry — exercises the "renew soon"
      // warning affordance in the list view AND lands inside the
      // expiry-sweep cron's 30-day reminder window so the demo shows
      // both the visual warning and (when the cron runs) the email-out
      // path. The Day 11 workaround that kept this as `pending_review`
      // is no longer necessary now that tests use an in-memory DB
      // (Day 12 Chunk 1) and don't read the dev seed.
      documentType: "trade_license",
      fileName: "Acme-Mumbai-Trade-License.pdf",
      status: "verified",
      sizeBytes: 245_000,
      mimeType: "application/pdf",
      issuedOn: "2025-01-15",
      expiresInDays: 18, // near expiry - exercises the warning affordance
      uploaderEmail: "acme@example.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: "Mumbai municipal trade license - renewal due within 30 days.",
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
  "Vertex Power Systems": [
    {
      // Verified-but-close-to-expiry GST. expiresInDays sits inside the
      // T-7 reminder window (2..7 days) so re-running the expiry-sweep
      // cron after a fresh seed surfaces this row as a fresh T-7
      // reminder. Pairs with the "Chunk 1 acceptance check: T-7
      // reminders go up by one" verification step in the Day 21 prompt.
      documentType: "gst_certificate",
      fileName: "Vertex-GST.pdf",
      status: "verified",
      sizeBytes: 168_000,
      mimeType: "application/pdf",
      issuedOn: "2024-05-20",
      expiresInDays: 5,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "staff@consultway.local",
      reviewNotes: "Renewal window open; T-7 reminder scheduled.",
    },
    {
      // The actual reason Vertex's complianceStatus is `expired` — the
      // trade license lapsed and the nightly cron flipped the
      // document's status. Exercises the "expired-but-not-deleted"
      // edge case alongside BuildRight's similar row.
      documentType: "trade_license",
      fileName: "Vertex-Jaipur-Trade-License-EXPIRED.pdf",
      status: "expired",
      sizeBytes: 213_000,
      mimeType: "application/pdf",
      issuedOn: "2022-06-15",
      expiresInDays: -85,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes:
        "Rajasthan Industrial Area trade license expired Q4 2025; renewal blocked pending pollution clearance.",
    },
  ],
  "Nimbus Infraworks": [
    {
      // Pre-confirm `pending` row — exercises the upload-initiated but
      // not-yet-bytes-landed slot in the documents lifecycle. The
      // seed-only artefact: in production this row would transition to
      // `pending_review` within minutes (or get pending-cleanup-cron'd
      // away). The seed-bound row sits indefinitely so the UI can
      // render the status pill in isolation.
      documentType: "gst_certificate",
      fileName: "Nimbus-GST-Pending-Confirm.pdf",
      status: "pending",
      sizeBytes: 192_000,
      mimeType: "application/pdf",
      issuedOn: "2024-09-01",
      expiresInDays: 365,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: null,
      reviewNotes: null,
    },
    {
      documentType: "pan_card",
      fileName: "Nimbus-PAN.pdf",
      status: "verified",
      sizeBytes: 94_000,
      mimeType: "application/pdf",
      issuedOn: "2018-11-22",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
      reviewNotes: null,
    },
    {
      documentType: "incorporation_cert",
      fileName: "Nimbus-CoI.pdf",
      status: "verified",
      sizeBytes: 402_000,
      mimeType: "application/pdf",
      issuedOn: "2018-11-15",
      expiresInDays: null,
      uploaderEmail: "staff@consultway.local",
      reviewerEmail: "admin@consultway.local",
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

// ── Seed data: tenders ─────────────────────────────────────────────────────

/**
 * Tender fixtures cover every `TenderStatus` value plus the long-tail
 * combinations the UI must render: msmeOnly mix, set/unset eligibility
 * filters, the over-the-line state (published + closingDate past), the
 * explicitly-closed state, and the awarded state with an
 * `awardedCompanyId` populated.
 *
 * Every tender is published by the Consultway Infotech sentinel
 * company (see CONSULTWAY_PUBLISHER_NAME). Subcontract tenders
 * published by client companies are out of scope for the Phase-1
 * seed — the publisher FK column is exercised either way.
 *
 * Idempotency: lookup by `referenceNumber` (every fixture sets one).
 * Re-running the seed against an already-seeded DB skips every row.
 */
export interface TenderSeed {
  title: string;
  referenceNumber: string;
  status: TenderStatus;
  description: string;
  sector: string;
  geography: string;
  eligibleSector: string | null;
  eligibleGeography: string | null;
  minAnnualTurnoverInr: number | null;
  msmeOnly: boolean;
  /** Days offset from today. Null leaves the column NULL. */
  openingInDays: number | null;
  closingInDays: number | null;
  /** Days offset from today for `publishedAt`. NULL for drafts. */
  publishedInDays: number | null;
  /** Name of the company that won an `awarded` tender. NULL otherwise. */
  awardedCompanyName: string | null;
  internalNotes: string | null;
}

const SEED_TENDERS: TenderSeed[] = [
  {
    // Draft — no publishing dates, no eligibility filters, no winner.
    // Covers the pre-publish state where staff are still drafting.
    title: "Metro Phase III Consulting Services (Draft)",
    referenceNumber: "CW-2026-DRAFT-001",
    status: "draft",
    description:
      "Draft scope for advisory + supervision on Metro Phase III civil works. Eligibility, dates, and turnover thresholds not yet finalised.",
    sector: "Infrastructure",
    geography: "Maharashtra",
    eligibleSector: null,
    eligibleGeography: null,
    minAnnualTurnoverInr: null,
    msmeOnly: false,
    openingInDays: null,
    closingInDays: null,
    publishedInDays: null,
    awardedCompanyName: null,
    internalNotes: "Awaiting finalised TOR from PMC. Hold publish until L1 sign-off.",
  },
  {
    // Published #1 — MSME-only, no turnover minimum, open today.
    // Only BuildRight (the MSME-flagged standalone) qualifies.
    title: "MSME Solar Rooftop Empanelment Drive 2026",
    referenceNumber: "CW-2026-MSME-SOLAR-002",
    status: "published",
    description:
      "MSME-reserved empanelment for rooftop solar installations under the Pan-India empanelment scheme. Standard scope, fixed-price contract.",
    sector: "Solar EPC",
    geography: "Pan India",
    eligibleSector: null,
    eligibleGeography: null,
    minAnnualTurnoverInr: null,
    msmeOnly: true,
    openingInDays: -30,
    closingInDays: 30,
    publishedInDays: -30,
    awardedCompanyName: null,
    internalNotes: null,
  },
  {
    // Published #2 — explicit sector + geography filters + high
    // turnover minimum (₹50 cr). Only Nimbus clears every gate.
    title: "Coastal Road Project — Phase 2 Civil Consortium Tender",
    referenceNumber: "CW-2026-INFRA-COASTAL-003",
    status: "published",
    description:
      "Phase-2 civil package for the Mumbai Coastal Road. Consortium bids welcome; lead partner must meet the stated turnover minimum.",
    sector: "Infrastructure",
    geography: "Maharashtra",
    eligibleSector: "Infrastructure",
    eligibleGeography: "Maharashtra",
    minAnnualTurnoverInr: 500_000_000, // ₹50 crore
    msmeOnly: false,
    openingInDays: -14,
    closingInDays: 45,
    publishedInDays: -14,
    awardedCompanyName: null,
    internalNotes: null,
  },
  {
    // Published #3 — over-the-line. closingDate already past but
    // status still `published`; the UI renders "closed via deadline"
    // rather than the explicit closed-by-staff state below.
    title: "Bengaluru Trunk Sewer Rehabilitation Tender",
    referenceNumber: "CW-2026-CIVIL-004",
    status: "published",
    description:
      "Civil works rehabilitation of the Bengaluru East trunk sewer. Open to qualified civil works contractors with prior municipal experience.",
    sector: "Civil Works",
    geography: "Karnataka",
    eligibleSector: "Civil Works",
    eligibleGeography: null,
    minAnnualTurnoverInr: null,
    msmeOnly: false,
    openingInDays: -60,
    closingInDays: -5, // PAST — over the line
    publishedInDays: -60,
    awardedCompanyName: null,
    internalNotes: "Closing date passed; pending status flip to `closed` by staff.",
  },
  {
    // Closed — staff explicitly closed the window after evaluations.
    // Has a high turnover minimum so only Nimbus could have qualified.
    title: "Highway PMC Tender — Section 12",
    referenceNumber: "CW-2026-ROADS-005",
    status: "closed",
    description:
      "Project management consultancy for Section 12 of the Chennai-Bengaluru highway expansion. Two-stage evaluation: technical + financial.",
    sector: "Roads & Highways",
    geography: "Tamil Nadu",
    eligibleSector: null,
    eligibleGeography: null,
    minAnnualTurnoverInr: 250_000_000, // ₹25 crore
    msmeOnly: false,
    openingInDays: -90,
    closingInDays: -30,
    publishedInDays: -90,
    awardedCompanyName: null,
    internalNotes: "Closed pending board evaluation; award decision deferred to Q3.",
  },
  {
    // Awarded — terminal state with an `awardedCompanyId`. The winning
    // company also gets a `shortlisted` application below as the
    // state-machine precondition to the award.
    title: "Andhra Solar Park Phase II — EPC Consulting",
    referenceNumber: "CW-2026-SOLAR-006",
    status: "awarded",
    description:
      "EPC advisory for the Andhra Pradesh 500MW solar park Phase II expansion. End-to-end consulting from design review through commissioning.",
    sector: "Solar EPC",
    geography: "Andhra Pradesh",
    eligibleSector: null,
    eligibleGeography: null,
    minAnnualTurnoverInr: null,
    msmeOnly: false,
    openingInDays: -180,
    closingInDays: -90,
    publishedInDays: -180,
    awardedCompanyName: "Nimbus Infraworks",
    internalNotes: "Awarded post evaluation cycle Q1 2026. Project record created via Phase-3 promotion flow.",
  },
];

// ── Seed data: tender applications ─────────────────────────────────────────

/**
 * Tender application fixtures. Covers every `TenderApplicationStatus`,
 * gives the awarded tender its winning company's `shortlisted`
 * precondition application, and puts one company (Nimbus) on three
 * tenders so the per-company applications list has multiple rows.
 *
 * Lookup is keyed by `(tenderReferenceNumber, companyName)` —
 * idempotent against the DB-level UNIQUE (tenderId, companyId).
 *
 * Note: seed-time inserts bypass the eligibility gate in
 * `applyToTender`. Several rows below would not pass the runtime gate
 * (e.g. Acme on a tender with a minimum turnover when Acme's stated
 * turnover is NULL) but the seed represents historical applications
 * staff later rejected — the rejected status carries that intent.
 */
export interface TenderApplicationSeed {
  tenderReferenceNumber: string;
  companyName: string;
  status: TenderApplicationStatus;
  coverNote: string | null;
  internalNotes: string | null;
  /** Days offset from today for the submitted timestamp. */
  submittedInDays: number;
  /**
   * Days offset for the decision timestamp. NULL for `submitted`
   * rows (no decision yet); required for shortlisted/rejected/withdrawn.
   */
  decidedInDays: number | null;
}

const SEED_TENDER_APPLICATIONS: TenderApplicationSeed[] = [
  // MSME Solar — BuildRight (MSME) qualifies, submitted recently.
  {
    tenderReferenceNumber: "CW-2026-MSME-SOLAR-002",
    companyName: "BuildRight Engineers",
    status: "submitted",
    coverNote:
      "BuildRight is MSME-certified with five years of rooftop solar deployment experience across South India.",
    internalNotes: null,
    submittedInDays: -7,
    decidedInDays: null,
  },
  // MSME Solar — the Acme-BuildRight JV applied but staff rejected
  // because the JV itself isn't MSME-flagged (only the BuildRight
  // partner is).
  {
    tenderReferenceNumber: "CW-2026-MSME-SOLAR-002",
    companyName: "Acme-BuildRight JV",
    status: "rejected",
    coverNote:
      "Joint venture entity submitting on the back of BuildRight's MSME credentials.",
    internalNotes:
      "Rejected: MSME eligibility is at the applying-entity level, not the partner level. The JV row itself is not MSME-flagged.",
    submittedInDays: -10,
    decidedInDays: -5,
  },
  // Coastal Road — Nimbus (₹100 cr turnover, Maharashtra, Infrastructure)
  // shortlisted after meeting every gate.
  {
    tenderReferenceNumber: "CW-2026-INFRA-COASTAL-003",
    companyName: "Nimbus Infraworks",
    status: "shortlisted",
    coverNote:
      "Tier-1 infrastructure firm with prior Mumbai coastal-zone project experience and audited turnover well above the stated minimum.",
    internalNotes: "Strong technical fit; advancing to financial round.",
    submittedInDays: -10,
    decidedInDays: -3,
  },
  // Coastal Road — Acme submitted but was rejected for the stated
  // turnover minimum (Acme's `annualTurnover` is NULL — couldn't
  // verify they cleared the bar).
  {
    tenderReferenceNumber: "CW-2026-INFRA-COASTAL-003",
    companyName: "Acme Construction Pvt Ltd",
    status: "rejected",
    coverNote:
      "Acme submitted with intent to subcontract through a finance partner.",
    internalNotes:
      "Rejected: applicant did not provide audited turnover statement. The stated minimum is binding; finance-partner workarounds are not supported under this tender.",
    submittedInDays: -12,
    decidedInDays: -8,
  },
  // Bengaluru Trunk Sewer — BuildRight (Karnataka, Civil Works)
  // submitted just before the deadline; sits as `submitted` even
  // though the tender's closingDate is past (mirrors the production
  // case where staff haven't run the close-via-deadline action yet).
  {
    tenderReferenceNumber: "CW-2026-CIVIL-004",
    companyName: "BuildRight Engineers",
    status: "submitted",
    coverNote:
      "BuildRight has prior municipal sewer rehabilitation experience in Bengaluru and Mysuru.",
    internalNotes: null,
    submittedInDays: -7,
    decidedInDays: null,
  },
  // Highway PMC (closed) — Nimbus shortlisted before the close.
  {
    tenderReferenceNumber: "CW-2026-ROADS-005",
    companyName: "Nimbus Infraworks",
    status: "shortlisted",
    coverNote: "PMC track record on three prior NHAI sections.",
    internalNotes: "Awaiting Q3 board decision.",
    submittedInDays: -85,
    decidedInDays: -45,
  },
  // Highway PMC (closed) — Acme rejected.
  {
    tenderReferenceNumber: "CW-2026-ROADS-005",
    companyName: "Acme Construction Pvt Ltd",
    status: "rejected",
    coverNote:
      "Application from Acme via a finance-partner consortium.",
    internalNotes: "Rejected for turnover documentation gaps; same pattern as Coastal Road application.",
    submittedInDays: -80,
    decidedInDays: -50,
  },
  // Andhra Solar (awarded) — Nimbus shortlisted (precondition to award).
  {
    tenderReferenceNumber: "CW-2026-SOLAR-006",
    companyName: "Nimbus Infraworks",
    status: "shortlisted",
    coverNote: "End-to-end EPC consulting capability with prior solar park experience.",
    internalNotes: "Winner — award processed Q1 2026.",
    submittedInDays: -160,
    decidedInDays: -100,
  },
  // Andhra Solar (awarded) — GreenTech withdrew before staff decision.
  {
    tenderReferenceNumber: "CW-2026-SOLAR-006",
    companyName: "GreenTech Solutions",
    status: "withdrawn",
    coverNote: "Initial interest in EPC consulting role.",
    internalNotes:
      "Company-initiated withdrawal: GreenTech pulled the application after their compliance review surfaced gaps. (Doc fixtures reflect this — their GST upload is rejected.)",
    submittedInDays: -170,
    decidedInDays: -130,
  },
];

// ── Seed data: projects ────────────────────────────────────────────────────

/**
 * Project fixtures cover every `ProjectStatus`, give the awarded
 * tender a promoted project (`tenderId` set), and include one
 * `active` project with an `endDate` in the past so the "overdue"
 * affordance has a row to render.
 *
 * Lookup: `(companyId, name)`.
 */
export interface ProjectSeed {
  name: string;
  companyName: string;
  /** Optional reference to a tender by `referenceNumber`. Promoted-from-tender path. */
  tenderReferenceNumber: string | null;
  status: ProjectStatus;
  description: string | null;
  /** Days offset from today. Null = NULL column. */
  startInDays: number | null;
  endInDays: number | null;
  /** Whole rupees. */
  budgetInr: number | null;
  internalNotes: string | null;
}

const SEED_PROJECTS: ProjectSeed[] = [
  {
    // planning — direct create, no tender link, dates in the future.
    name: "Mumbai Coastal Stretch Survey",
    companyName: "Acme Construction Pvt Ltd",
    tenderReferenceNumber: null,
    status: "planning",
    description:
      "Pre-tender baseline survey for the Mumbai coastal stretch project. Scope-finalisation pending PMC sign-off.",
    startInDays: 30,
    endInDays: 180,
    budgetInr: 5_000_000, // ₹50 lakh
    internalNotes: "Awaiting client confirmation on instrumentation budget.",
  },
  {
    // active — direct create, in-flight today.
    name: "BuildRight Bengaluru Trunk Sewer PMC",
    companyName: "BuildRight Engineers",
    tenderReferenceNumber: null,
    status: "active",
    description:
      "Project management consultancy for the Bengaluru East trunk sewer rehabilitation. Phase 1 (mobilisation) complete; Phase 2 (excavation) underway.",
    startInDays: -60,
    endInDays: 120,
    budgetInr: 12_000_000, // ₹1.2 crore
    internalNotes: null,
  },
  {
    // on_hold — paused mid-execution for external reasons.
    name: "GreenTech Tamil Nadu Solar Park PMC",
    companyName: "GreenTech Solutions",
    tenderReferenceNumber: null,
    status: "on_hold",
    description:
      "Solar park PMC engagement paused pending regulatory clearance for the land parcel.",
    startInDays: -90,
    endInDays: 90,
    budgetInr: 18_000_000, // ₹1.8 crore
    internalNotes:
      "Hold pending TANGEDCO grid-connection clearance. ETA Q3 2026 per client.",
  },
  {
    // completed — terminal state.
    name: "Nimbus DLF Phase III Office Tower",
    companyName: "Nimbus Infraworks",
    tenderReferenceNumber: null,
    status: "completed",
    description:
      "Civil + structural advisory for the DLF Phase III office tower. Handover completed Q1 2026.",
    startInDays: -365,
    endInDays: -30,
    budgetInr: 80_000_000, // ₹8 crore
    internalNotes: "Closeout complete; final certificate issued 2026-04-22.",
  },
  {
    // cancelled — terminal state.
    name: "Modern-Alpha Highway Maintenance",
    companyName: "Modern-Alpha Alliance",
    tenderReferenceNumber: null,
    status: "cancelled",
    description:
      "Highway maintenance advisory cancelled after the client retracted scope. Project record retained for audit.",
    startInDays: -180,
    endInDays: 90,
    budgetInr: 25_000_000, // ₹2.5 crore
    internalNotes:
      "Cancellation triggered by client. Refund processed against advances — see refund transaction.",
  },
  {
    // active + overdue endDate + promoted from awarded tender.
    // Covers two of the seed-plan's specific edge cases in one row:
    // the tender-promoted path AND the overdue affordance.
    name: "Andhra Solar Park Phase II EPC Consulting",
    companyName: "Nimbus Infraworks",
    tenderReferenceNumber: "CW-2026-SOLAR-006",
    status: "active",
    description:
      "EPC advisory for the Andhra Pradesh 500MW solar park Phase II expansion. Awarded via tender CW-2026-SOLAR-006.",
    startInDays: -90,
    endInDays: -7, // OVERDUE — endDate already past, status still active
    budgetInr: 150_000_000, // ₹15 crore
    internalNotes:
      "Endpoint slipped past planned close; pending CEO sign-off on a revised schedule extension.",
  },
];

// ── Seed data: transactions ────────────────────────────────────────────────

/**
 * Transaction fixtures. ≥3 rows per `TransactionType`, spread across
 * the last three months so both `getTransactionsSummaryThisMonth`
 * and `getTransactionsSummaryForPeriod` (with arbitrary period
 * windows) have non-trivial data. Each type also includes one
 * company-level row (no `projectName`) to exercise the NULL-project
 * branch.
 *
 * Cross-FK invariant: when `projectName` is set, the project's
 * `companyName` MUST match this row's `companyName`. The seed
 * helper re-asserts this at insert time and fails loudly if a
 * fixture violates it.
 *
 * Lookup: `(companyName, referenceNumber)`. Every fixture sets a
 * unique reference so re-running the seed skips correctly.
 */
export interface TransactionSeed {
  type: TransactionType;
  /** Amount in PAISE (1 INR = 100 paise). */
  amountPaise: number;
  companyName: string;
  /** Optional project link by name. NULL = company-level transaction. */
  projectName: string | null;
  /** Days offset from today for the `occurredOn` business date. */
  occurredInDays: number;
  referenceNumber: string;
  notes: string | null;
}

const SEED_TRANSACTIONS: TransactionSeed[] = [
  // ── invoices (4) ──────────────────────────────────────────────────
  {
    type: "invoice",
    amountPaise: 50_000_000, // ₹5,00,000
    companyName: "Acme Construction Pvt Ltd",
    projectName: "Mumbai Coastal Stretch Survey",
    occurredInDays: -13,
    referenceNumber: "INV-2026-0501",
    notes: "Phase-1 consulting invoice — Mumbai Coastal Stretch Survey.",
  },
  {
    type: "invoice",
    amountPaise: 120_000_000, // ₹12,00,000
    companyName: "BuildRight Engineers",
    projectName: "BuildRight Bengaluru Trunk Sewer PMC",
    occurredInDays: -38,
    referenceNumber: "INV-2026-0415",
    notes: "Mobilisation invoice — Bengaluru Trunk Sewer PMC.",
  },
  {
    type: "invoice",
    amountPaise: 250_000_000, // ₹25,00,000
    companyName: "Nimbus Infraworks",
    projectName: "Andhra Solar Park Phase II EPC Consulting",
    occurredInDays: -64,
    referenceNumber: "INV-2026-0320",
    notes: "Q1 EPC consulting invoice — Andhra Solar Park Phase II.",
  },
  {
    type: "invoice",
    amountPaise: 30_000_000, // ₹3,00,000
    companyName: "Nimbus Infraworks",
    projectName: null,
    occurredInDays: -18,
    referenceNumber: "INV-2026-0505",
    notes: "Annual retainer invoice — Nimbus advisory (company-level).",
  },

  // ── payments (4) ──────────────────────────────────────────────────
  {
    type: "payment",
    amountPaise: 25_000_000, // ₹2,50,000
    companyName: "Acme Construction Pvt Ltd",
    projectName: "Mumbai Coastal Stretch Survey",
    occurredInDays: -8,
    referenceNumber: "PMT-2026-0515",
    notes: "Partial payment received against INV-2026-0501.",
  },
  {
    type: "payment",
    amountPaise: 80_000_000, // ₹8,00,000
    companyName: "BuildRight Engineers",
    projectName: "BuildRight Bengaluru Trunk Sewer PMC",
    occurredInDays: -28,
    referenceNumber: "PMT-2026-0425",
    notes: "Payment received against INV-2026-0415.",
  },
  {
    type: "payment",
    amountPaise: 150_000_000, // ₹15,00,000
    companyName: "Nimbus Infraworks",
    projectName: "Andhra Solar Park Phase II EPC Consulting",
    occurredInDays: -56,
    referenceNumber: "PMT-2026-0328",
    notes: "Partial payment against Q1 EPC invoice.",
  },
  {
    type: "payment",
    amountPaise: 5_000_000, // ₹50,000
    companyName: "GreenTech Solutions",
    projectName: null,
    occurredInDays: -15,
    referenceNumber: "PMT-2026-0508",
    notes: "Onboarding fee — GreenTech (company-level).",
  },

  // ── expenses (4) ──────────────────────────────────────────────────
  {
    type: "expense",
    amountPaise: 7_500_000, // ₹75,000
    companyName: "Acme Construction Pvt Ltd",
    projectName: "Mumbai Coastal Stretch Survey",
    occurredInDays: -11,
    referenceNumber: "EXP-2026-0512",
    notes: "Site visit + topographic survey gear hire.",
  },
  {
    type: "expense",
    amountPaise: 15_000_000, // ₹1,50,000
    companyName: "BuildRight Engineers",
    projectName: "BuildRight Bengaluru Trunk Sewer PMC",
    occurredInDays: -35,
    referenceNumber: "EXP-2026-0418",
    notes: "Drone survey contractor — Bengaluru East corridor.",
  },
  {
    type: "expense",
    amountPaise: 22_000_000, // ₹2,20,000
    companyName: "Nimbus Infraworks",
    projectName: "Andhra Solar Park Phase II EPC Consulting",
    occurredInDays: -62,
    referenceNumber: "EXP-2026-0322",
    notes: "Geotechnical lab testing — Andhra Solar Park substation site.",
  },
  {
    type: "expense",
    amountPaise: 1_500_000, // ₹15,000
    companyName: "Acme Construction Pvt Ltd",
    projectName: null,
    occurredInDays: -21,
    referenceNumber: "EXP-2026-0502",
    notes: "Annual GST filing fee (company-level).",
  },

  // ── advances (4) ──────────────────────────────────────────────────
  {
    type: "advance",
    amountPaise: 50_000_000, // ₹5,00,000
    companyName: "BuildRight Engineers",
    projectName: "BuildRight Bengaluru Trunk Sewer PMC",
    occurredInDays: -43,
    referenceNumber: "ADV-2026-0410",
    notes: "Vendor mobilisation advance — excavation contractor.",
  },
  {
    type: "advance",
    amountPaise: 100_000_000, // ₹10,00,000
    companyName: "Nimbus Infraworks",
    projectName: "Andhra Solar Park Phase II EPC Consulting",
    occurredInDays: -69,
    referenceNumber: "ADV-2026-0315",
    notes: "Mobilisation advance — design consultant.",
  },
  {
    type: "advance",
    amountPaise: 50_000_000, // ₹5,00,000
    companyName: "Nimbus Infraworks",
    projectName: "Nimbus DLF Phase III Office Tower",
    occurredInDays: -74,
    referenceNumber: "ADV-2026-0310",
    notes: "Final advance for DLF Phase III closeout.",
  },
  {
    type: "advance",
    amountPaise: 10_000_000, // ₹1,00,000
    companyName: "BuildRight Engineers",
    projectName: null,
    occurredInDays: -17,
    referenceNumber: "ADV-2026-0506",
    notes: "Vendor retainer — company-level (cross-project advisory bench).",
  },

  // ── refunds (4) ───────────────────────────────────────────────────
  {
    type: "refund",
    amountPaise: 2_500_000, // ₹25,000
    companyName: "GreenTech Solutions",
    projectName: "GreenTech Tamil Nadu Solar Park PMC",
    occurredInDays: -5,
    referenceNumber: "REF-2026-0518",
    notes: "Overpayment refunded — GreenTech Tamil Nadu Solar Park PMC.",
  },
  {
    type: "refund",
    amountPaise: 12_500_000, // ₹1,25,000
    companyName: "Modern-Alpha Alliance",
    projectName: "Modern-Alpha Highway Maintenance",
    occurredInDays: -31,
    referenceNumber: "REF-2026-0422",
    notes: "Cancellation refund — Modern-Alpha Highway Maintenance scope retracted.",
  },
  {
    type: "refund",
    amountPaise: 4_000_000, // ₹40,000
    companyName: "Nimbus Infraworks",
    projectName: "Nimbus DLF Phase III Office Tower",
    occurredInDays: -48,
    referenceNumber: "REF-2026-0405",
    notes: "Refund of unused mobilisation advance after DLF Phase III closeout.",
  },
  {
    type: "refund",
    amountPaise: 1_000_000, // ₹10,000
    companyName: "Acme Construction Pvt Ltd",
    projectName: null,
    occurredInDays: -3,
    referenceNumber: "REF-2026-0520",
    notes: "Refund of duplicate retainer payment (company-level).",
  },
];

// ── Seeding helpers ───────────────────────────────────────────────────────

/**
 * Per-seeder return value. The seed used to be a two-state machine
 * ("created" | "skipped") with idempotency-by-skip. Day 21 Chunk 3
 * adds the third state by adopting compare-and-update on the
 * documented safe-to-update field set:
 *
 *   - `inserted`  — natural-key lookup missed; full row inserted.
 *   - `updated`   — natural-key matched but at least one safe-to-
 *                   update field differs; row UPDATEd in place.
 *   - `unchanged` — natural-key matched and every safe-to-update
 *                   field equals the spec. Replaces the old "skipped".
 *
 * Frozen fields (primary keys, natural-key columns, FK columns,
 * audit timestamps, password hashes) are EXCLUDED from the diff and
 * from the UPDATE set. Each seeder documents its frozen set inline.
 *
 * The contract is now: idempotent on identical fixtures, self-healing
 * on changed fixtures — bump a company's annualTurnover in the spec
 * and re-run `pnpm db:seed`, the column updates rather than skipping.
 */
export type SeedResult = "inserted" | "updated" | "unchanged";

export interface SeedTally {
  inserted: number;
  updated: number;
  unchanged: number;
}

function newTally(): SeedTally {
  return { inserted: 0, updated: 0, unchanged: 0 };
}

function bumpTally(t: SeedTally, r: SeedResult): void {
  t[r]++;
}

/**
 * Compare a current DB row against the spec-derived "intended" column
 * values, returning the list of field names that differ. Empty result
 * = no UPDATE needed.
 *
 * Arrays are compared by JSON-serialised value (handles
 * `parentCompanyIds` and other `mode: 'json'` columns). Everything
 * else is strict-equality (booleans, nullables, scalars).
 */
function diffFields<T extends Record<string, unknown>>(
  current: T,
  intended: Partial<T>,
): Array<keyof T & string> {
  const changed: Array<keyof T & string> = [];
  for (const key of Object.keys(intended) as Array<keyof T & string>) {
    const c = current[key];
    const i = intended[key];
    if (Array.isArray(c) || Array.isArray(i)) {
      if (JSON.stringify(c) !== JSON.stringify(i)) changed.push(key);
    } else if (c !== i) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Seed one Consultway staff user (admin or staff role, no company link).
 *
 * Frozen on update: `id`, `email` (natural key), `passwordHash`
 * (re-hashing on every seed run would be expensive and pointless —
 * to rotate a password, delete the row), `companyId` (admin/staff
 * have none; never moves), `createdAt`, `updatedAt`.
 *
 * Updatable: `role`, `name`, `isActive`, `emailVerifiedAt`.
 */
export async function seedStaffUser(
  spec: StaffUserSeed,
): Promise<SeedResult> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, spec.email))
    .limit(1)
    .then((rows) => rows[0]);

  const updatable = {
    role: spec.role,
    name: spec.name,
    isActive: spec.isActive,
    emailVerifiedAt: spec.emailVerifiedAt,
  };

  if (!existing) {
    const passwordHash = await hashPassword(spec.plaintextPassword);
    await db.insert(users).values({
      id: newId(),
      email: spec.email,
      passwordHash,
      companyId: null,
      ...updatable,
    });
    log.info("user inserted", { email: spec.email, role: spec.role });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("user unchanged", { email: spec.email });
    return "unchanged";
  }
  await db.update(users).set(updatable).where(eq(users.id, existing.id));
  log.info("user updated", { email: spec.email, changed });
  return "updated";
}

/**
 * Seed one company-role user. Looks up the named company at insert
 * time so the user's `companyId` FK is real. Throws if the named
 * company doesn't exist — that would mean the standalone-companies
 * step didn't run first, which is a bug worth surfacing loudly.
 */
export async function seedCompanyUser(
  spec: CompanyUserSeed,
): Promise<SeedResult> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, spec.email))
    .limit(1)
    .then((rows) => rows[0]);

  // Updatable shape for the compare-and-update path.
  // Frozen: id, email, passwordHash, companyId (moves between companies
  // are real-world audit events, not seed-time corrections), createdAt,
  // updatedAt. Updatable: name, isActive, emailVerifiedAt.
  const updatable = {
    name: spec.name,
    isActive: spec.isActive,
    emailVerifiedAt: spec.emailVerifiedAt,
  };

  if (!existing) {
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
      ...updatable,
    });
    log.info("company user inserted", {
      email: spec.email,
      companyName: spec.companyName,
    });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("company user unchanged", { email: spec.email });
    return "unchanged";
  }
  await db.update(users).set(updatable).where(eq(users.id, existing.id));
  log.info("company user updated", { email: spec.email, changed });
  return "updated";
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
export async function seedConsultwayPublisher(): Promise<SeedResult> {
  const existing = await db
    .select()
    .from(companies)
    .where(eq(companies.name, CONSULTWAY_PUBLISHER_NAME))
    .limit(1)
    .then((rows) => rows[0]);

  // Frozen: id, name (natural key), createdAt, updatedAt.
  // The publisher is a singleton — most of these fields rarely move,
  // but keeping internalNotes / contact info updatable means we can
  // edit them in the seed and have changes take effect.
  const updatable = {
    sector: "Consulting",
    geography: "Pan India",
    gstNumber: null as string | null,
    panNumber: null as string | null,
    isMsme: false,
    isJv: false,
    complianceStatus: "compliant" as ComplianceStatus,
    parentCompanyIds: null as string[] | null,
    annualTurnover: null as number | null,
    contactEmail: "ops@consultway.local" as string | null,
    contactPhone: null as string | null,
    contactPersonName: "Consultway Operations" as string | null,
    addressLine: null as string | null,
    city: null as string | null,
    state: null as string | null,
    pincode: null as string | null,
    internalNotes:
      "Internal sentinel company. Used as the publisher of Consultway-run tenders. Do not delete." as string | null,
    rejectionReason: null as string | null,
  };

  if (!existing) {
    await db.insert(companies).values({
      id: newId(),
      name: CONSULTWAY_PUBLISHER_NAME,
      ...updatable,
    });
    log.info("Consultway publisher inserted", {
      name: CONSULTWAY_PUBLISHER_NAME,
    });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("Consultway publisher unchanged", {
      name: CONSULTWAY_PUBLISHER_NAME,
    });
    return "unchanged";
  }
  await db.update(companies).set(updatable).where(eq(companies.id, existing.id));
  log.info("Consultway publisher updated", {
    name: CONSULTWAY_PUBLISHER_NAME,
    changed,
  });
  return "updated";
}

/**
 * Seed one standalone company. Idempotency check is by `name` —
 * pragmatic for a dev seed (the company name is human-meaningful and
 * unique in our seed set). Production datasets use the unique GST/PAN
 * constraints instead, but those are nullable in seed data so name is
 * the better key here.
 */
export async function seedStandaloneCompany(
  spec: StandaloneSeed,
): Promise<SeedResult> {
  const existing = await db
    .select()
    .from(companies)
    .where(eq(companies.name, spec.name))
    .limit(1)
    .then((rows) => rows[0]);

  // Frozen: id, name (natural key), isJv (architectural — non-JV
  // companies can't morph into JVs at seed time), createdAt, updatedAt.
  // Everything else is fixture-driven and safe to update — including
  // the Day-22 `rejectionReason` column so a fixture edit propagates.
  const updatable = {
    sector: spec.sector,
    geography: spec.geography,
    gstNumber: spec.gstNumber ?? null,
    panNumber: spec.panNumber ?? null,
    isMsme: spec.isMsme,
    complianceStatus: spec.complianceStatus,
    parentCompanyIds: null as string[] | null,
    annualTurnover: spec.annualTurnover ?? null,
    contactEmail: spec.contactEmail ?? null,
    contactPhone: spec.contactPhone ?? null,
    contactPersonName: spec.contactPersonName ?? null,
    addressLine: spec.addressLine ?? null,
    city: spec.city ?? null,
    state: spec.state ?? null,
    pincode: spec.pincode ?? null,
    internalNotes: spec.internalNotes ?? null,
    rejectionReason: spec.rejectionReason ?? null,
  };

  if (!existing) {
    await db.insert(companies).values({
      id: newId(),
      name: spec.name,
      isJv: false,
      ...updatable,
    });
    log.info("company inserted", { name: spec.name, sector: spec.sector });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("company unchanged", { name: spec.name });
    return "unchanged";
  }
  await db.update(companies).set(updatable).where(eq(companies.id, existing.id));
  log.info("company updated", { name: spec.name, changed });
  return "updated";
}

/**
 * Seed one JV. Looks up each partner by name, fails loudly if any
 * partner doesn't exist (would mean the standalones didn't seed,
 * which is itself a bug worth surfacing).
 */
export async function seedJvCompany(spec: JvSeed): Promise<SeedResult> {
  const existing = await db
    .select()
    .from(companies)
    .where(eq(companies.name, spec.name))
    .limit(1)
    .then((rows) => rows[0]);

  // Partner-id resolution happens for both paths — on update we
  // re-resolve so a fixture that changes its partner list takes
  // effect on re-seed.
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

  // Frozen: id, name (natural key), isJv (architectural), createdAt,
  // updatedAt. Everything else is fixture-driven.
  const updatable = {
    sector: spec.sector,
    geography: spec.geography,
    gstNumber: spec.gstNumber ?? null,
    panNumber: spec.panNumber ?? null,
    isMsme: spec.isMsme,
    complianceStatus: spec.complianceStatus,
    parentCompanyIds: partnerIds,
    annualTurnover: null as number | null,
    contactEmail: spec.contactEmail ?? null,
    contactPhone: spec.contactPhone ?? null,
    contactPersonName: spec.contactPersonName ?? null,
    addressLine: spec.addressLine ?? null,
    city: spec.city ?? null,
    state: spec.state ?? null,
    pincode: spec.pincode ?? null,
    internalNotes: spec.internalNotes ?? null,
    rejectionReason: null as string | null,
  };

  if (!existing) {
    await db.insert(companies).values({
      id: newId(),
      name: spec.name,
      isJv: true,
      ...updatable,
    });
    log.info("JV inserted", {
      name: spec.name,
      partnerCount: partnerIds.length,
    });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("JV unchanged", { name: spec.name });
    return "unchanged";
  }
  await db.update(companies).set(updatable).where(eq(companies.id, existing.id));
  log.info("JV updated", { name: spec.name, changed });
  return "updated";
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
export async function seedDocumentsForCompany(
  companyName: string,
  specs: DocumentSeed[],
): Promise<SeedTally> {
  const tally = newTally();

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
    // Natural key: (companyId, fileName) — fileName is unique within
    // a company in the fixture set.
    const existing = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.companyId, company.id),
          eq(documents.fileName, spec.fileName),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    const uploadedById = emailToId.get(spec.uploaderEmail)!;
    const reviewedById = spec.reviewerEmail
      ? emailToId.get(spec.reviewerEmail)!
      : null;

    // Frozen on update: id, companyId, fileKey (depends on documentId
    // in its path), fileName (natural key with companyId), uploadedBy,
    // uploadedAt, reviewedAt (preserves the original review timestamp
    // even if status changes — re-stamping every re-seed would make
    // identical fixtures look "changed"), createdAt, updatedAt.
    // Updatable: documentType, mimeType, sizeBytes, status, reviewNotes,
    // reviewedBy, issuedOn, expiresAt.
    const updatable = {
      documentType: spec.documentType,
      mimeType: spec.mimeType,
      sizeBytes: spec.sizeBytes,
      status: spec.status,
      reviewNotes: spec.reviewNotes ?? null,
      reviewedBy: reviewedById,
      issuedOn: spec.issuedOn ?? null,
      expiresAt: isoDateOffset(spec.expiresInDays),
    };

    if (!existing) {
      const documentId = newId();
      const isReviewed =
        spec.status === "verified" ||
        spec.status === "rejected" ||
        spec.status === "expired";
      const reviewedAt = isReviewed ? new Date().toISOString() : null;
      await db.insert(documents).values({
        id: documentId,
        companyId: company.id,
        // Demo metadata - bytes don't actually exist in R2. The fileKey
        // shape matches what `lib/r2/keys.ts::buildDocumentKey` produces
        // so the action layer's RBAC checks behave identically against
        // these rows.
        fileKey: `companies/${company.id}/${documentId}/${spec.fileName}`,
        fileName: spec.fileName,
        ...updatable,
        reviewedAt,
        uploadedBy: uploadedById,
        uploadedAt: new Date().toISOString(),
      });
      bumpTally(tally, "inserted");
      continue;
    }

    const changed = diffFields(existing, updatable);
    if (changed.length === 0) {
      bumpTally(tally, "unchanged");
      continue;
    }
    await db
      .update(documents)
      .set(updatable)
      .where(eq(documents.id, existing.id));
    log.info("document updated", {
      companyName,
      fileName: spec.fileName,
      changed,
    });
    bumpTally(tally, "updated");
  }

  log.info("seeded documents for company", {
    companyName,
    inserted: tally.inserted,
    updated: tally.updated,
    unchanged: tally.unchanged,
  });

  return tally;
}

// ── Phase-2/3 seeding helpers ─────────────────────────────────────────────

/**
 * Look up a company UUID by name. Fails loudly if the named company
 * doesn't exist — used as a precondition guard in the tender / project /
 * transaction seeders that all reference companies by name to keep the
 * fixture file readable.
 */
async function lookupCompanyId(name: string): Promise<string> {
  const row = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, name))
    .limit(1)
    .then((rows) => rows[0]);
  if (!row) {
    throw new Error(
      `Phase-2/3 seed references company "${name}" but no such company exists. Did the standalone/JV seeds run first?`,
    );
  }
  return row.id;
}

/**
 * Look up a user UUID by email. Used by the audit-on-insert helper for
 * generator-emitted rows. Throws if absent — would mean an upstream
 * generator emitted a user we haven't seeded yet.
 */
async function lookupUserId(email: string): Promise<string> {
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .then((rows) => rows[0]);
  if (!row) {
    throw new Error(`Seed lookup: user "${email}" not found.`);
  }
  return row.id;
}

/**
 * Same lookup, but returns the SYSTEM sentinel id when the user is
 * absent. Used at startup to find the admin actor id without forcing
 * the seed to fail if someone has renamed the admin email.
 */
async function lookupUserIdOptional(email: string): Promise<string> {
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .then((rows) => rows[0]);
  return row?.id ?? "00000000-0000-0000-0000-000000000000";
}

/**
 * Thin wrapper around `recordAuditEvent` that:
 *   - defaults the actorId to the system sentinel when omitted,
 *   - never throws (matches `recordAuditEvent`'s contract).
 *
 * Called only from generator paths after an `inserted` result — the
 * existing hand-curated seeders intentionally don't audit (would have
 * added cross-cutting noise to the Day-21 baseline tests).
 */
async function recordSeedAudit(event: {
  actorId?: string;
  actorRole: "admin" | "staff" | "company" | "system";
  action: Parameters<typeof recordAuditEvent>[0]["action"];
  targetType: Parameters<typeof recordAuditEvent>[0]["targetType"];
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordAuditEvent({
    actorId: event.actorId ?? "00000000-0000-0000-0000-000000000000",
    actorRole: event.actorRole,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    before: event.before,
    after: event.after,
    metadata: event.metadata,
  });
}

/**
 * Seed one `reminders_sent` row. Idempotent on
 * `(documentId, reminderKind)` — the DB-level UNIQUE index would
 * refuse a duplicate anyway, but checking ahead surfaces the skip
 * cleanly instead of a UNIQUE failure.
 */
export async function seedReminderSent(spec: {
  companyName: string;
  fileName: string;
  kind: "T-30" | "T-14" | "T-7" | "T-1";
  sentInDays: number;
}): Promise<SeedResult> {
  const companyId = await lookupCompanyId(spec.companyName);
  const doc = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.companyId, companyId), eq(documents.fileName, spec.fileName)),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (!doc) {
    throw new Error(
      `Seed reminder references document "${spec.fileName}" on company "${spec.companyName}" but no such document exists.`,
    );
  }

  const existing = await db
    .select({ id: remindersSent.id })
    .from(remindersSent)
    .where(
      and(
        eq(remindersSent.documentId, doc.id),
        eq(remindersSent.reminderKind, spec.kind),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    return "unchanged";
  }

  const sentAt = new Date(
    Date.now() + spec.sentInDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.insert(remindersSent).values({
    id: newId(),
    documentId: doc.id,
    reminderKind: spec.kind,
    sentAt,
  });
  return "inserted";
}

/**
 * Seed one tender. Idempotency check by `referenceNumber`. Resolves
 * the publisher (Consultway sentinel) + optional awarded company by
 * name at insert time so the file stays readable.
 */
export async function seedTender(spec: TenderSeed): Promise<SeedResult> {
  const existing = await db
    .select()
    .from(tenders)
    .where(eq(tenders.referenceNumber, spec.referenceNumber))
    .limit(1)
    .then((rows) => rows[0]);

  const awardedCompanyId = spec.awardedCompanyName
    ? await lookupCompanyId(spec.awardedCompanyName)
    : null;

  // Frozen: id, referenceNumber (natural key), publisherCompanyId
  // (a publisher change is a real-world event, not a seed-time edit),
  // publishedAt (the original publish timestamp matters for the audit
  // chain — re-stamping every re-seed would make identical fixtures
  // look "changed"), createdAt, updatedAt. Updatable: everything else.
  const updatable = {
    title: spec.title,
    description: spec.description ?? null,
    status: spec.status,
    sector: spec.sector,
    geography: spec.geography,
    eligibleSector: spec.eligibleSector ?? null,
    eligibleGeography: spec.eligibleGeography ?? null,
    minAnnualTurnoverInr: spec.minAnnualTurnoverInr ?? null,
    msmeOnly: spec.msmeOnly,
    openingDate: isoDateOffset(spec.openingInDays),
    closingDate: isoDateOffset(spec.closingInDays),
    awardedCompanyId,
    internalNotes: spec.internalNotes ?? null,
  };

  if (!existing) {
    const publisherId = await lookupCompanyId(CONSULTWAY_PUBLISHER_NAME);
    await db.insert(tenders).values({
      id: newId(),
      referenceNumber: spec.referenceNumber,
      publisherCompanyId: publisherId,
      publishedAt:
        spec.publishedInDays !== null
          ? new Date(
              Date.now() + spec.publishedInDays * 24 * 60 * 60 * 1000,
            ).toISOString()
          : null,
      ...updatable,
    });
    log.info("tender inserted", {
      referenceNumber: spec.referenceNumber,
      status: spec.status,
    });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("tender unchanged", { referenceNumber: spec.referenceNumber });
    return "unchanged";
  }
  await db.update(tenders).set(updatable).where(eq(tenders.id, existing.id));
  log.info("tender updated", {
    referenceNumber: spec.referenceNumber,
    changed,
  });
  return "updated";
}

/**
 * Seed one tender application. Idempotency by `(tenderId, companyId)`
 * — the DB-level unique index would refuse a duplicate anyway, but
 * checking ahead lets us log the skip cleanly instead of surfacing a
 * UNIQUE failure.
 */
export async function seedTenderApplication(
  spec: TenderApplicationSeed,
): Promise<SeedResult> {
  const tender = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(eq(tenders.referenceNumber, spec.tenderReferenceNumber))
    .limit(1)
    .then((rows) => rows[0]);
  if (!tender) {
    throw new Error(
      `Tender application references tender "${spec.tenderReferenceNumber}" but no such tender exists. Did the tenders seed run first?`,
    );
  }
  const companyId = await lookupCompanyId(spec.companyName);

  const existing = await db
    .select()
    .from(tenderApplications)
    .where(
      and(
        eq(tenderApplications.tenderId, tender.id),
        eq(tenderApplications.companyId, companyId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  // Frozen: id, tenderId, companyId (composite natural key — moving an
  // application between tenders or companies is not a meaningful
  // operation), submittedAt (write-once; the original submission
  // timestamp is load-bearing for the audit chain), createdAt,
  // updatedAt. Updatable: status, coverNote, internalNotes, decidedAt.
  const updatable = {
    status: spec.status,
    coverNote: spec.coverNote ?? null,
    internalNotes: spec.internalNotes ?? null,
    decidedAt:
      spec.decidedInDays !== null
        ? new Date(
            Date.now() + spec.decidedInDays * 24 * 60 * 60 * 1000,
          ).toISOString()
        : null,
  };

  if (!existing) {
    const submittedAt = new Date(
      Date.now() + spec.submittedInDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    await db.insert(tenderApplications).values({
      id: newId(),
      tenderId: tender.id,
      companyId,
      submittedAt,
      ...updatable,
    });
    log.info("tender application inserted", {
      tenderReferenceNumber: spec.tenderReferenceNumber,
      companyName: spec.companyName,
      status: spec.status,
    });
    return "inserted";
  }

  // decidedAt is a derived timestamp — exclude it from the diff so
  // identical fixtures don't show as "updated" on every re-seed. If
  // status changes we still want to update decidedAt; that's covered
  // because the UPDATE set always includes the freshly-computed value.
  const updatableForDiff = {
    status: updatable.status,
    coverNote: updatable.coverNote,
    internalNotes: updatable.internalNotes,
  };
  const changed = diffFields(existing, updatableForDiff);
  if (changed.length === 0) {
    log.info("tender application unchanged", {
      tenderReferenceNumber: spec.tenderReferenceNumber,
      companyName: spec.companyName,
    });
    return "unchanged";
  }
  await db
    .update(tenderApplications)
    .set(updatable)
    .where(eq(tenderApplications.id, existing.id));
  log.info("tender application updated", {
    tenderReferenceNumber: spec.tenderReferenceNumber,
    companyName: spec.companyName,
    changed,
  });
  return "updated";
}

/**
 * Seed one project. Idempotency by `(companyId, name)`. Resolves
 * the optional tender link by `referenceNumber`.
 */
export async function seedProject(spec: ProjectSeed): Promise<SeedResult> {
  const companyId = await lookupCompanyId(spec.companyName);

  const existing = await db
    .select()
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.name, spec.name)))
    .limit(1)
    .then((rows) => rows[0]);

  let tenderId: string | null = null;
  if (spec.tenderReferenceNumber) {
    const tender = await db
      .select({ id: tenders.id })
      .from(tenders)
      .where(eq(tenders.referenceNumber, spec.tenderReferenceNumber))
      .limit(1)
      .then((rows) => rows[0]);
    if (!tender) {
      throw new Error(
        `Project "${spec.name}" references tender "${spec.tenderReferenceNumber}" but no such tender exists.`,
      );
    }
    tenderId = tender.id;
  }

  // Frozen: id, companyId (cross-FK with transactions — moving a
  // project between companies is a real-world event, not a seed
  // edit), name (natural key with companyId), createdAt, updatedAt.
  // Updatable: description, tenderId, status, startDate, endDate,
  // budgetInr, internalNotes.
  const updatable = {
    description: spec.description ?? null,
    tenderId,
    status: spec.status,
    startDate: isoDateOffset(spec.startInDays),
    endDate: isoDateOffset(spec.endInDays),
    budgetInr: spec.budgetInr ?? null,
    internalNotes: spec.internalNotes ?? null,
  };

  if (!existing) {
    await db.insert(projects).values({
      id: newId(),
      name: spec.name,
      companyId,
      ...updatable,
    });
    log.info("project inserted", {
      companyName: spec.companyName,
      name: spec.name,
      status: spec.status,
    });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("project unchanged", {
      companyName: spec.companyName,
      name: spec.name,
    });
    return "unchanged";
  }
  await db.update(projects).set(updatable).where(eq(projects.id, existing.id));
  log.info("project updated", {
    companyName: spec.companyName,
    name: spec.name,
    changed,
  });
  return "updated";
}

/**
 * Seed one transaction. Idempotency by `(companyId, referenceNumber)`.
 *
 * Cross-FK invariant: when `projectName` is set, the referenced
 * project's `companyId` MUST equal this row's `companyId`. The seed
 * re-asserts this defensively because a typo in the fixture would
 * silently corrupt the ledger.
 */
export async function seedTransaction(
  spec: TransactionSeed,
): Promise<SeedResult> {
  const companyId = await lookupCompanyId(spec.companyName);

  const existing = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        eq(transactions.referenceNumber, spec.referenceNumber),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  let projectId: string | null = null;
  if (spec.projectName) {
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(
        and(
          eq(projects.companyId, companyId),
          eq(projects.name, spec.projectName),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!project) {
      throw new Error(
        `Transaction ${spec.referenceNumber} references project "${spec.projectName}" on company "${spec.companyName}" but no such project exists. (Cross-FK invariant — the project's companyId must equal the transaction's companyId.)`,
      );
    }
    projectId = project.id;
  }

  // Frozen: id, companyId (cross-FK with project), referenceNumber
  // (natural key with companyId), createdAt, updatedAt. Updatable:
  // type, amountPaise, currency, projectId, occurredOn, notes,
  // internalNotes.
  const updatable = {
    type: spec.type,
    amountPaise: spec.amountPaise,
    currency: "INR",
    projectId,
    occurredOn: isoDateOffset(spec.occurredInDays)!,
    notes: spec.notes ?? null,
    internalNotes: null as string | null,
  };

  if (!existing) {
    await db.insert(transactions).values({
      id: newId(),
      companyId,
      referenceNumber: spec.referenceNumber,
      ...updatable,
    });
    log.info("transaction inserted", {
      companyName: spec.companyName,
      referenceNumber: spec.referenceNumber,
      type: spec.type,
    });
    return "inserted";
  }

  const changed = diffFields(existing, updatable);
  if (changed.length === 0) {
    log.info("transaction unchanged", {
      companyName: spec.companyName,
      referenceNumber: spec.referenceNumber,
    });
    return "unchanged";
  }
  await db
    .update(transactions)
    .set(updatable)
    .where(eq(transactions.id, existing.id));
  log.info("transaction updated", {
    companyName: spec.companyName,
    referenceNumber: spec.referenceNumber,
    changed,
  });
  return "updated";
}

// ── Demo cheat-sheet ──────────────────────────────────────────────────────

/**
 * Print a human-readable summary of the seeded DB. The structured log
 * line above is for machines; this one is for the demo presenter — a
 * one-screen reference for "what's in this DB right now" with login
 * credentials grouped by role.
 *
 * Uses `console.log` directly (the same escape hatch the cron scripts
 * use for their result echo). The structured logger's JSON output is
 * great for grepping but rough for eyeballing.
 */
async function printDemoCheatSheet(scale: SeedScale): Promise<void> {
  // Counts by status / type — single grouped query per dimension.
  const companiesByStatus = await db
    .select({
      status: companies.complianceStatus,
      n: sql<number>`count(*)`,
    })
    .from(companies)
    .groupBy(companies.complianceStatus);

  const documentsByStatus = await db
    .select({ status: documents.status, n: sql<number>`count(*)` })
    .from(documents)
    .groupBy(documents.status);

  const tendersByStatus = await db
    .select({ status: tenders.status, n: sql<number>`count(*)` })
    .from(tenders)
    .groupBy(tenders.status);

  const applicationsByStatus = await db
    .select({ status: tenderApplications.status, n: sql<number>`count(*)` })
    .from(tenderApplications)
    .groupBy(tenderApplications.status);

  const projectsByStatus = await db
    .select({ status: projects.status, n: sql<number>`count(*)` })
    .from(projects)
    .groupBy(projects.status);

  const transactionsByType = await db
    .select({ type: transactions.type, n: sql<number>`count(*)` })
    .from(transactions)
    .groupBy(transactions.type);

  // Aggregate totals.
  const [{ totalBudget }] = await db
    .select({ totalBudget: sql<number>`coalesce(sum(${projects.budgetInr}), 0)` })
    .from(projects);
  const [{ totalTxn }] = await db
    .select({ totalTxn: sql<number>`coalesce(sum(${transactions.amountPaise}), 0)` })
    .from(transactions);

  // Users grouped by role for the login cheat-sheet.
  const userRows = await db
    .select({ email: users.email, role: users.role, isActive: users.isActive })
    .from(users)
    .orderBy(users.role, users.email);
  const usersByRole = new Map<string, Array<{ email: string; isActive: boolean }>>();
  for (const u of userRows) {
    const arr = usersByRole.get(u.role) ?? [];
    arr.push({ email: u.email, isActive: u.isActive });
    usersByRole.set(u.role, arr);
  }

  const fmt = (rows: Array<{ status?: string; type?: string; n: number }>) =>
    rows
      .map((r) => `${(r.status ?? r.type) ?? "?"}=${r.n}`)
      .sort()
      .join(", ");
  const formatInr = (rupees: number): string =>
    rupees >= 10_000_000
      ? `₹${(rupees / 10_000_000).toFixed(2)} cr`
      : rupees >= 100_000
        ? `₹${(rupees / 100_000).toFixed(2)} lakh`
        : `₹${rupees.toLocaleString("en-IN")}`;

  // eslint-disable-next-line no-console
  console.log(`\n────────────────────────────────────────────────────────────`);
  // eslint-disable-next-line no-console
  console.log(`  Consultway Ops — seed cheat sheet (scale=${scale})`);
  // eslint-disable-next-line no-console
  console.log(`────────────────────────────────────────────────────────────`);
  // eslint-disable-next-line no-console
  console.log(`  Companies   : ${fmt(companiesByStatus)}`);
  // eslint-disable-next-line no-console
  console.log(`  Documents   : ${fmt(documentsByStatus)}`);
  // eslint-disable-next-line no-console
  console.log(`  Tenders     : ${fmt(tendersByStatus)}`);
  // eslint-disable-next-line no-console
  console.log(`  Applications: ${fmt(applicationsByStatus)}`);
  // eslint-disable-next-line no-console
  console.log(`  Projects    : ${fmt(projectsByStatus)}`);
  // eslint-disable-next-line no-console
  console.log(`  Transactions: ${fmt(transactionsByType)}`);
  // eslint-disable-next-line no-console
  console.log(`  Total project budget : ${formatInr(Number(totalBudget))}`);
  // eslint-disable-next-line no-console
  console.log(
    `  Total transaction sum: ${formatInr(Math.round(Number(totalTxn) / 100))}`,
  );
  // eslint-disable-next-line no-console
  console.log(`\n  Login cheat-sheet (password for every account: ChangeMe123!)`);
  for (const role of ["admin", "staff", "company"] as const) {
    const xs = usersByRole.get(role) ?? [];
    if (xs.length === 0) continue;
    // eslint-disable-next-line no-console
    console.log(`    [${role}] (${xs.length} accounts)`);
    for (const u of xs) {
      // eslint-disable-next-line no-console
      console.log(`      - ${u.email}${u.isActive ? "" : "  (DISABLED)"}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`────────────────────────────────────────────────────────────\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const scale = resolveSeedScale();
  log.info("starting seed", { scale });

  const coreStats = newTally();

  // 1. Consultway staff users first — independent of companies.
  for (const spec of SEED_STAFF_USERS) {
    bumpTally(coreStats, await seedStaffUser(spec));
  }

  // 1b. Scale-driven additional staff/admin users (Day 22 Chunk 3).
  //     Pulls the targets from SEED_SCALE_PROFILES via the generator.
  //     The dynamic import keeps the seed.ts → seed-generators.ts edge
  //     non-circular at parse time (generators import types from us).
  const generators = await import("./seed-generators");
  const generatedStaff = generators.generateStaffUsers(scale);
  for (const spec of generatedStaff) {
    const r = await seedStaffUser(spec);
    bumpTally(coreStats, r);
    if (r === "inserted") {
      const userId = await lookupUserId(spec.email);
      await recordSeedAudit({
        actorRole: "system",
        action: "created",
        targetType: "user",
        targetId: userId,
        after: { email: spec.email, role: spec.role, name: spec.name },
      });
    }
  }

  // Capture the admin actor id — used by the audit-on-insert helper
  // for generator-emitted rows. Falls back to the system actor id if
  // for some reason the admin isn't there.
  const adminActorId = await lookupUserIdOptional("admin@consultway.local");

  // 2. Consultway publisher sentinel — must exist before any tender seed
  //    runs since `tenders.publisherCompanyId` is NOT NULL.
  bumpTally(coreStats, await seedConsultwayPublisher());

  // 3. Standalone companies — must exist before JVs that reference them.
  for (const spec of STANDALONE_COMPANIES) {
    bumpTally(coreStats, await seedStandaloneCompany(spec));
  }

  // 3b. Scale-driven additional standalone companies.
  const existingStandaloneCount =
    STANDALONE_COMPANIES.length + JV_COMPANIES.length;
  const generatedCompanies = generators.generateStandaloneCompanies(
    scale,
    existingStandaloneCount,
  );
  for (const spec of generatedCompanies) {
    const r = await seedStandaloneCompany(spec);
    bumpTally(coreStats, r);
    if (r === "inserted") {
      const companyId = await lookupCompanyId(spec.name);
      await recordSeedAudit({
        actorId: adminActorId,
        actorRole: "admin",
        action: "created",
        targetType: "company",
        targetId: companyId,
        after: {
          name: spec.name,
          sector: spec.sector,
          geography: spec.geography,
          complianceStatus: spec.complianceStatus,
          isMsme: spec.isMsme,
        },
      });
    }
  }

  // 4. JVs — they look up their partners by name.
  for (const spec of JV_COMPANIES) {
    bumpTally(coreStats, await seedJvCompany(spec));
  }

  // 5. Company-role users — they reference a client company by name,
  //    so the named companies must exist by this point.
  for (const spec of SEED_COMPANY_USERS) {
    bumpTally(coreStats, await seedCompanyUser(spec));
  }

  // 5b. Scale-driven additional company-role users (one per generated
  //     company that isn't rejected). Skipped for `small` profile when
  //     the generator emitted zero new companies.
  const generatedCompanyUsers = generators.generateCompanyUsers(
    scale,
    generatedCompanies,
  );
  for (const spec of generatedCompanyUsers) {
    const r = await seedCompanyUser(spec);
    bumpTally(coreStats, r);
    if (r === "inserted") {
      const userId = await lookupUserId(spec.email);
      await recordSeedAudit({
        actorId: adminActorId,
        actorRole: "admin",
        action: "created",
        targetType: "user",
        targetId: userId,
        after: { email: spec.email, role: "company", companyName: spec.companyName },
      });
    }
  }

  // 6. Document fixtures. Documents reference both a company
  //    (FK companyId) and users (FK uploadedBy, reviewedBy), so all
  //    earlier steps must have run.
  const docStats = newTally();
  for (const [companyName, specs] of Object.entries(DOCUMENTS_PER_COMPANY)) {
    const tally = await seedDocumentsForCompany(companyName, specs);
    docStats.inserted += tally.inserted;
    docStats.updated += tally.updated;
    docStats.unchanged += tally.unchanged;
  }

  // 6b. Scale-driven additional documents across the generated companies.
  //     Uploader pool = staff (baseline + generated); reviewer pool = admins.
  const allStaffEmails = [
    ...SEED_STAFF_USERS.filter((u) => u.role === "staff").map((u) => u.email),
    ...generatedStaff.filter((u) => u.role === "staff").map((u) => u.email),
  ];
  const allAdminEmails = [
    ...SEED_STAFF_USERS.filter((u) => u.role === "admin").map((u) => u.email),
    ...generatedStaff.filter((u) => u.role === "admin").map((u) => u.email),
  ];
  const existingDocCount = Object.values(DOCUMENTS_PER_COMPANY).reduce(
    (s, xs) => s + xs.length,
    0,
  );
  const generatedDocs = generators.generateDocuments(
    scale,
    generatedCompanies,
    allStaffEmails.length > 0 ? allStaffEmails : allAdminEmails,
    allAdminEmails,
    existingDocCount,
  );
  // Group by company so the existing per-company seeder can process
  // them in one batch (it resolves the uploader/reviewer ids once
  // per call).
  const generatedByCompany = new Map<string, DocumentSeed[]>();
  for (const entry of generatedDocs) {
    const arr = generatedByCompany.get(entry.companyName) ?? [];
    arr.push(entry.spec);
    generatedByCompany.set(entry.companyName, arr);
  }
  for (const [companyName, specs] of generatedByCompany) {
    const before = await db
      .select({ id: documents.id, fileName: documents.fileName })
      .from(documents)
      .innerJoin(companies, eq(documents.companyId, companies.id))
      .where(eq(companies.name, companyName));
    const beforeNames = new Set(before.map((r) => r.fileName));

    const tally = await seedDocumentsForCompany(companyName, specs);
    docStats.inserted += tally.inserted;
    docStats.updated += tally.updated;
    docStats.unchanged += tally.unchanged;

    // Audit only the rows that didn't exist before.
    if (tally.inserted > 0) {
      const after = await db
        .select({ id: documents.id, fileName: documents.fileName })
        .from(documents)
        .innerJoin(companies, eq(documents.companyId, companies.id))
        .where(eq(companies.name, companyName));
      for (const row of after) {
        if (beforeNames.has(row.fileName)) continue;
        await recordSeedAudit({
          actorId: adminActorId,
          actorRole: "admin",
          action: "document_uploaded",
          targetType: "document",
          targetId: row.id,
          after: { companyName, fileName: row.fileName },
        });
      }
    }
  }

  // 6c. Scale-driven `reminders_sent` rows. The cron's natural history
  //     is what the dashboard's audit feed widget surfaces; without
  //     pre-populating a few rows the feed looks empty on a fresh seed.
  const reminderSpecs = generators.generateReminders(scale, generatedDocs);
  const reminderStats = newTally();
  for (const spec of reminderSpecs) {
    bumpTally(reminderStats, await seedReminderSent(spec));
  }

  // 7. Tenders — reference the Consultway publisher sentinel + an
  //    awarded company. All earlier company seeds must have landed.
  const tenderStats = newTally();
  for (const spec of SEED_TENDERS) {
    bumpTally(tenderStats, await seedTender(spec));
  }

  // 7b. Scale-driven additional tenders.
  const generatedTenders = generators.generateTenders(
    scale,
    SEED_TENDERS.length,
    generatedCompanies,
  );
  for (const spec of generatedTenders) {
    const r = await seedTender(spec);
    bumpTally(tenderStats, r);
    if (r === "inserted") {
      const tenderRow = await db
        .select({ id: tenders.id })
        .from(tenders)
        .where(eq(tenders.referenceNumber, spec.referenceNumber))
        .limit(1)
        .then((rs) => rs[0]);
      if (tenderRow) {
        await recordSeedAudit({
          actorId: adminActorId,
          actorRole: "admin",
          action: spec.status === "draft" ? "created" : "tender_published",
          targetType: "tender",
          targetId: tenderRow.id,
          after: {
            referenceNumber: spec.referenceNumber,
            title: spec.title,
            status: spec.status,
          },
        });
      }
    }
  }

  // 8. Tender applications — depend on both tenders and companies.
  const applicationStats = newTally();
  for (const spec of SEED_TENDER_APPLICATIONS) {
    bumpTally(applicationStats, await seedTenderApplication(spec));
  }

  // 8b. Scale-driven additional applications across the generated tenders.
  const generatedApps = generators.generateTenderApplications(
    scale,
    generatedTenders,
    generatedCompanies,
  );
  for (const spec of generatedApps) {
    const r = await seedTenderApplication(spec);
    bumpTally(applicationStats, r);
    if (r === "inserted") {
      // Resolve the application id for the audit row. We have the
      // tender + company; the unique (tenderId, companyId) tuple lets
      // us look up the row deterministically.
      const tenderRow = await db
        .select({ id: tenders.id })
        .from(tenders)
        .where(eq(tenders.referenceNumber, spec.tenderReferenceNumber))
        .limit(1)
        .then((rs) => rs[0]);
      const companyId = await lookupCompanyId(spec.companyName);
      if (tenderRow) {
        const appRow = await db
          .select({ id: tenderApplications.id })
          .from(tenderApplications)
          .where(
            and(
              eq(tenderApplications.tenderId, tenderRow.id),
              eq(tenderApplications.companyId, companyId),
            ),
          )
          .limit(1)
          .then((rs) => rs[0]);
        if (appRow) {
          await recordSeedAudit({
            actorId: adminActorId,
            actorRole: "company",
            action: "tender_applied",
            targetType: "tender",
            targetId: tenderRow.id,
            metadata: {
              tenderReferenceNumber: spec.tenderReferenceNumber,
              companyName: spec.companyName,
              applicationId: appRow.id,
              status: spec.status,
            },
          });
        }
      }
    }
  }

  // 9. Projects — may reference an awarded tender. Companies must exist.
  const projectStats = newTally();
  for (const spec of SEED_PROJECTS) {
    bumpTally(projectStats, await seedProject(spec));
  }

  // 9b. Scale-driven additional projects on top of the baseline.
  const generatedProjects = generators.generateProjects(
    scale,
    SEED_PROJECTS.length,
    generatedCompanies,
    generatedTenders,
  );
  for (const spec of generatedProjects) {
    const r = await seedProject(spec);
    bumpTally(projectStats, r);
    if (r === "inserted") {
      const companyId = await lookupCompanyId(spec.companyName);
      const projectRow = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.name, spec.name)))
        .limit(1)
        .then((rs) => rs[0]);
      if (projectRow) {
        await recordSeedAudit({
          actorId: adminActorId,
          actorRole: "admin",
          action: "created",
          targetType: "project",
          targetId: projectRow.id,
          after: {
            name: spec.name,
            companyName: spec.companyName,
            status: spec.status,
          },
        });
      }
    }
  }

  // 10. Transactions — may reference a project; cross-FK invariant
  //     re-asserted inside the seeder. Projects must exist.
  const transactionStats = newTally();
  for (const spec of SEED_TRANSACTIONS) {
    bumpTally(transactionStats, await seedTransaction(spec));
  }

  // 10b. Scale-driven transactions spread across the last 12 months.
  // Combine baseline + generated projects so the project-link pool is
  // realistic. The transaction generator's PRNG is independent so
  // shuffling baseline in doesn't affect determinism.
  const allProjectSpecs = [...SEED_PROJECTS, ...generatedProjects];
  const generatedTxns = generators.generateTransactions(
    scale,
    SEED_TRANSACTIONS.length,
    generatedCompanies,
    allProjectSpecs,
  );
  for (const spec of generatedTxns) {
    const r = await seedTransaction(spec);
    bumpTally(transactionStats, r);
    if (r === "inserted") {
      const companyId = await lookupCompanyId(spec.companyName);
      const txnRow = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.companyId, companyId),
            eq(transactions.referenceNumber, spec.referenceNumber),
          ),
        )
        .limit(1)
        .then((rs) => rs[0]);
      if (txnRow) {
        await recordSeedAudit({
          actorId: adminActorId,
          actorRole: "admin",
          action: "created",
          targetType: "transaction",
          targetId: txnRow.id,
          after: {
            referenceNumber: spec.referenceNumber,
            type: spec.type,
            companyName: spec.companyName,
            projectName: spec.projectName,
          },
        });
      }
    }
  }

  log.info("seed complete", {
    scale,
    core: coreStats,
    documents: docStats,
    reminders: reminderStats,
    tenders: tenderStats,
    tenderApplications: applicationStats,
    projects: projectStats,
    transactions: transactionStats,
  });

  // Human-readable cheat-sheet for the demo presenter. The structured
  // log above is for grep; this one is for eyeballs.
  await printDemoCheatSheet(scale);

  // Close the SQLite connection so the script exits cleanly. Without
  // this, the process hangs on the open file handle.
  const { default: Database } = await import("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite = (globalThis as any).__sqlite as
    | InstanceType<typeof Database>
    | undefined;
  sqlite?.close();
}

// Only run `main()` when invoked directly via `tsx scripts/seed.ts`.
// Tests import the individual seeders from this module (see
// `scripts/__tests__/seed.test.ts`) and must not trigger the full
// pipeline on import. `VITEST` is set by Vitest itself; the env-var
// signal is cleaner than ESM `import.meta`-vs-`process.argv[1]` URL
// equality, which is finicky on Windows path separators.
if (!process.env.VITEST) {
  main().catch((err) => {
    log.error("seed failed", { err });
    process.exit(1);
  });
}
