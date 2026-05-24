/**
 * Fixture generators for the Day-22 volume lift.
 *
 * The Day-21 seed shipped a hand-curated 7-company baseline that covers
 * every state on the long-tail axis. Day-22 keeps that baseline and
 * stacks scale-driven generators on top so the dashboard / reports /
 * audit feed have enough data to feel like a real post-launch dataset.
 *
 * Every generator here:
 *   - Reads its target count from `SEED_SCALE_PROFILES[scale]`.
 *   - Uses a deterministic PRNG (mulberry32, seed = 1) so generated
 *     values are stable across runs — critical for the
 *     compare-and-update self-healing contract (non-deterministic
 *     specs would re-render as "updated" on every re-seed).
 *   - Emits specs in the same shape the existing seeders accept; no
 *     new insert pathways.
 *
 * @module scripts/seed-generators
 */
import {
  SEED_SCALE_PROFILES,
  SEED_VERIFIED_AT,
  type CompanyUserSeed,
  type DocumentSeed,
  type SeedScale,
  type StandaloneSeed,
  type StaffUserSeed,
} from "./seed";
import type { DocumentStatus, DocumentType } from "@/lib/db/schema";

// ── Deterministic PRNG ────────────────────────────────────────────────────

/**
 * Mulberry32 — one of the smaller correct 32-bit PRNGs. Seeded from a
 * fixed integer so every generator call sequence produces identical
 * output across runs. Deterministic specs are the load-bearing
 * property for the seed's self-healing contract (any non-determinism
 * would land as a spurious "updated" on every re-seed).
 *
 * https://stackoverflow.com/a/47593316
 */
export function makePrng(seed = 1): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one element of an array. */
function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

/** Inclusive integer in [lo, hi]. */
function int(rng: () => number, lo: number, hi: number): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

// ── Pools ─────────────────────────────────────────────────────────────────
/**
 * Pools of plausible-but-clearly-placeholder values. Names are
 * Indian-flavoured but obviously fictitious (no real CIN/GST format
 * checks are run against them at seed time). A polish pass with
 * verifiable formats is a separate UX task — flagged in the Day-21
 * report's followups #2.
 */
const SECTOR_POOL = [
  "Infrastructure",
  "Solar EPC",
  "Civil Works",
  "Renewable",
  "Real Estate",
  "Manufacturing",
] as const;

const GEOGRAPHY_POOL = [
  "Maharashtra",
  "Karnataka",
  "Tamil Nadu",
  "Delhi NCR",
  "Gujarat",
  "Pan India",
] as const;

const CITY_PER_GEO: Record<(typeof GEOGRAPHY_POOL)[number], string> = {
  Maharashtra: "Mumbai",
  Karnataka: "Bengaluru",
  "Tamil Nadu": "Chennai",
  "Delhi NCR": "Gurugram",
  Gujarat: "Ahmedabad",
  "Pan India": "Mumbai",
};

const PINCODE_PER_GEO: Record<(typeof GEOGRAPHY_POOL)[number], string> = {
  Maharashtra: "400001",
  Karnataka: "560001",
  "Tamil Nadu": "600001",
  "Delhi NCR": "110001",
  Gujarat: "380001",
  "Pan India": "400001",
};

/**
 * 30 fictitious company-name roots. Mix of plausible Indian
 * infrastructure / EPC / consulting names. Suffix appended by the
 * generator ensures uniqueness when the pool is exhausted.
 */
const COMPANY_NAME_POOL = [
  "Orion Build",
  "Helix Energy",
  "Apex Civil",
  "Sundar Engineering",
  "Pinnacle Power",
  "Kavi Construction",
  "Bharat Solar Works",
  "Saraswati Builders",
  "Ganga EPC",
  "Vaidya Renewable",
  "Mantra Infraprojects",
  "Sentinel Civil",
  "Solis Solar India",
  "Indrayani Build",
  "Bhumi Construct",
  "Anand Civil Tech",
  "Akashdeep Solar",
  "Tejas Infraworks",
  "Suryam Power",
  "Maitra Civil",
  "Sahyadri Construct",
  "Pavan Energy",
  "Ratan Infra",
  "Surya Build",
  "Veer Civil",
  "Tara Solar",
  "Niraj Engineering",
  "Madhav Renewables",
  "Aditya Civil Works",
  "Karuna Builders",
] as const;

const FIRST_NAMES = [
  "Arjun",
  "Aanya",
  "Ravi",
  "Meera",
  "Sunil",
  "Pooja",
  "Vikram",
  "Anjali",
  "Karan",
  "Divya",
  "Rohit",
  "Sneha",
  "Aditya",
  "Kavya",
  "Mohan",
  "Lakshmi",
  "Sandeep",
  "Neha",
  "Manish",
  "Priti",
] as const;

const LAST_NAMES = [
  "Sharma",
  "Patel",
  "Iyer",
  "Reddy",
  "Khanna",
  "Mehta",
  "Singh",
  "Joshi",
  "Verma",
  "Banerjee",
] as const;

const REJECTION_REASONS = [
  "Background check surfaced unresolved tax disputes; re-apply after settlement.",
  "Submitted GST + PAN did not match the company name on file; identity verification failed.",
  "Prior contract default within the last 24 months; cooling-off period in effect.",
  "Audited financials below the platform's minimum gross turnover floor.",
  "Compliance review found unverifiable claims on prior project experience.",
  "Pending litigation flagged by legal review; reapply after disposition.",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Produce a deterministic GST-shaped string. Not a verifiable GSTIN
 * (the checksum is not real). Useful only as a unique non-null
 * placeholder for fixtures.
 */
function fakeGst(index: number): string {
  const stateCode = String(((index % 35) + 1)).padStart(2, "0");
  // 10-char PAN-shaped placeholder using a stable hash of the index.
  const padded = String(index).padStart(4, "0");
  return `${stateCode}GEN${padded}A1Z${(index % 10)}`;
}

function fakePan(index: number): string {
  const padded = String(index).padStart(4, "0");
  return `GENPC${padded}A`;
}

function fakePhone(index: number): string {
  return `+91 22 ${String(5000 + (index % 5000)).padStart(4, "0")} ${String(((index * 137) % 10000)).padStart(4, "0")}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ── Companies ─────────────────────────────────────────────────────────────

/**
 * Generate additional standalone-company specs to reach the SEED_SCALE
 * target on top of the hand-curated baseline. Counts are derived from
 * the profile:
 *
 *   - 4 pending, 3 suspended, 3 rejected.
 *   - The remainder of the target count fills `compliant`.
 *
 * The generator emits up to `profile.companies - existingCount` rows.
 * For `small` profiles where existingCount already exceeds the target,
 * the generator emits zero (the baseline alone covers it).
 */
export function generateStandaloneCompanies(
  scale: SeedScale,
  existingCount: number,
): StandaloneSeed[] {
  const profile = SEED_SCALE_PROFILES[scale];
  const targetTotal = profile.companies;
  const need = Math.max(0, targetTotal - existingCount);
  if (need === 0) return [];

  const rng = makePrng(101);
  const out: StandaloneSeed[] = [];

  // Status distribution. Numbers below sum to `targetTotal`; we want
  // the GENERATOR to fill the slots not covered by the baseline:
  //   - 4 pending total; baseline has 1 (GreenTech) → generate 3
  //   - 20 compliant total; baseline has 4 → generate 16
  //   - 3 suspended total → generate 3
  //   - 3 rejected total → generate 3
  //   - existing expired/non_compliant rows untouched
  //
  // We can't know the baseline's status mix without inspecting the
  // baseline arrays — but for simplicity we hand-tune the generator's
  // mix to reach the seed-plan totals when the baseline is the Day-21
  // 7-company set. For small/medium scales we proportionally reduce.
  const ratios: Array<{ status: StandaloneSeed["complianceStatus"]; weight: number }> = [
    { status: "pending", weight: 3 },
    { status: "suspended", weight: 3 },
    { status: "rejected", weight: 3 },
    { status: "compliant", weight: 16 },
  ];
  const totalWeight = ratios.reduce((s, r) => s + r.weight, 0);

  // For each ratio, compute how many rows of that status to emit.
  const allocations = ratios.map((r) => ({
    status: r.status,
    count: Math.round((r.weight / totalWeight) * need),
  }));
  // Round-off drift correction: trim/pad the last allocation so the
  // totals add up exactly.
  const allocated = allocations.reduce((s, a) => s + a.count, 0);
  if (allocated !== need) {
    allocations[allocations.length - 1]!.count += need - allocated;
  }

  let nameIndex = 0;
  let rowIndex = 100; // start IDs at 100 to avoid colliding with the
  // existing handcrafted GST numbers (Day-21 used 07/08/27/29/33 state
  // codes; the generator picks up from there).

  for (const a of allocations) {
    for (let i = 0; i < a.count; i++) {
      const baseName = COMPANY_NAME_POOL[nameIndex % COMPANY_NAME_POOL.length]!;
      const suffix = Math.floor(nameIndex / COMPANY_NAME_POOL.length);
      const name = suffix === 0 ? baseName : `${baseName} ${suffix + 1}`;
      nameIndex++;

      const sector = pick(rng, SECTOR_POOL);
      const geography = pick(rng, GEOGRAPHY_POOL);
      const isMsme = rng() < 0.27; // ~27% MSME-flagged — gets us to
      // ~8 generated MSMEs in the `large` profile.

      // ~12 of the generated rows carry a stated annualTurnover.
      // Spread from ₹2 cr to ₹500 cr — covers every realistic tender
      // minimum the Chunk-4 generator will set.
      const hasTurnover = rng() < 0.55;
      const turnover = hasTurnover
        ? Math.round(2_00_00_000 + rng() * 498_00_00_000)
        : null;

      const rejectionReason =
        a.status === "rejected"
          ? pick(rng, REJECTION_REASONS)
          : null;

      out.push({
        name,
        sector,
        geography,
        gstNumber: fakeGst(rowIndex),
        panNumber: fakePan(rowIndex),
        isMsme,
        complianceStatus: a.status,
        annualTurnover: turnover,
        contactEmail: `${slugify(name)}@example.local`,
        contactPhone: fakePhone(rowIndex),
        contactPersonName: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
        addressLine: `${int(rng, 1, 99)} ${pick(rng, ["MG Road", "Industrial Estate", "Tech Park", "Sector 4", "Phase II"])}`,
        city: CITY_PER_GEO[geography],
        state: geography === "Pan India" ? "Maharashtra" : geography,
        pincode: PINCODE_PER_GEO[geography],
        internalNotes:
          a.status === "rejected"
            ? `Rejected at intake. Reason on file (see rejectionReason).`
            : a.status === "suspended"
              ? "Suspended pending internal review; restorable to compliant on resolution."
              : null,
        rejectionReason,
      });
      rowIndex++;
    }
  }

  return out;
}

// ── Company users ─────────────────────────────────────────────────────────

/**
 * Generate one company-role user per active (non-rejected, non-suspended)
 * generated company. Mix in ~1-in-5 disabled users so the staff roster
 * has visible inactive accounts.
 */
export function generateCompanyUsers(
  scale: SeedScale,
  generatedCompanies: StandaloneSeed[],
): CompanyUserSeed[] {
  const rng = makePrng(202);
  const out: CompanyUserSeed[] = [];
  let idx = 0;
  for (const c of generatedCompanies) {
    // Only active-ish companies get a self-service user. Rejected
    // companies can't log in to operate anyway, and suspended ones are
    // paused — skipping them keeps the user roster aligned with the
    // operational reality.
    if (c.complianceStatus === "rejected") continue;

    const slug = slugify(c.name);
    const isActive = idx % 5 !== 0;
    out.push({
      email: `${slug}@example.local`,
      plaintextPassword: "ChangeMe123!",
      name: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)} (${c.name})`,
      companyName: c.name,
      isActive,
      emailVerifiedAt: SEED_VERIFIED_AT,
    });
    idx++;
  }

  // Bigger admin / staff teams for the large profile.
  // We don't emit these — the baseline already has 1 admin + 2 staff
  // which is enough for the role-collision tests. Extra admins/staff
  // add visual noise without exercising new code paths.

  return out;
}

/**
 * Generate additional admin + staff users on top of the baseline (1
 * admin, 2 staff). Targets 3 admins + 6 staff per the seed-plan for
 * the `large` profile.
 */
export function generateStaffUsers(scale: SeedScale): StaffUserSeed[] {
  const rng = makePrng(303);
  const out: StaffUserSeed[] = [];

  const adminTargets = scale === "large" ? 3 : scale === "medium" ? 2 : 1;
  const staffTargets = scale === "large" ? 6 : scale === "medium" ? 4 : 2;

  // Baseline already has 1 admin (admin@consultway.local), 2 staff
  // (staff@consultway.local, staff2@consultway.local).
  const adminNeed = Math.max(0, adminTargets - 1);
  const staffNeed = Math.max(0, staffTargets - 2);

  for (let i = 0; i < adminNeed; i++) {
    out.push({
      email: `admin${i + 2}@consultway.info`,
      plaintextPassword: "ChangeMe123!",
      role: "admin",
      name: `Admin ${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
      isActive: true,
      emailVerifiedAt: SEED_VERIFIED_AT,
    });
  }
  for (let i = 0; i < staffNeed; i++) {
    out.push({
      email: `staff${i + 3}@consultway.info`,
      plaintextPassword: "ChangeMe123!",
      role: "staff",
      name: `Staff ${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
      isActive: true,
      emailVerifiedAt: SEED_VERIFIED_AT,
    });
  }

  return out;
}

// ── Documents ────────────────────────────────────────────────────────────

const DOCUMENT_TYPE_POOL: DocumentType[] = [
  "gst_certificate",
  "pan_card",
  "incorporation_cert",
  "board_resolution",
  "cancelled_cheque",
  "trade_license",
  "other",
];

/**
 * Generate 4-6 documents per non-rejected company. Status mix:
 * 60% verified / 20% pending_review / 10% rejected / 10% expired.
 * ~10 in the 30-day expiry window; ~3 past expiry.
 *
 * The caller passes both the existing baseline doc count and the
 * generated companies + staff/admin users — we resolve uploader
 * (typically staff) + reviewer (typically admin) from those pools.
 *
 * Idempotency: file names embed the company slug + a stable index
 * so the natural key `(companyId, fileName)` is reproducible.
 */
export function generateDocuments(
  scale: SeedScale,
  generatedCompanies: StandaloneSeed[],
  uploaderEmails: string[],
  reviewerEmails: string[],
  existingCount: number,
): Array<{ companyName: string; spec: DocumentSeed }> {
  const profile = SEED_SCALE_PROFILES[scale];
  const target = profile.documents;
  const need = Math.max(0, target - existingCount);
  if (need === 0) return [];

  const rng = makePrng(404);
  const out: Array<{ companyName: string; spec: DocumentSeed }> = [];

  // Distribute `need` docs roughly evenly across the generated
  // companies. If we have N generated companies and need M docs,
  // give each company `floor(M / N)` docs and spread the remainder.
  const eligibleCompanies = generatedCompanies.filter(
    (c) => c.complianceStatus !== "rejected",
  );
  if (eligibleCompanies.length === 0) return [];

  const perCompanyBase = Math.floor(need / eligibleCompanies.length);
  const remainder = need - perCompanyBase * eligibleCompanies.length;

  // Status weight buckets — 60/20/10/10 mix.
  function pickStatus(): DocumentStatus {
    const r = rng();
    if (r < 0.6) return "verified";
    if (r < 0.8) return "pending_review";
    if (r < 0.9) return "rejected";
    return "expired";
  }

  // We want ~10 docs with expiresInDays in (0, 30] and ~3 past
  // expiry across the WHOLE generated set. Use counters to ration.
  // Budgets are deliberately a bit higher than the targets because
  // the doc-type filter (PAN cards and incorporation certs never
  // expire) skips a fraction of the candidates.
  let nearExpiryBudget = 16;
  let pastExpiryBudget = 6;

  for (let cIdx = 0; cIdx < eligibleCompanies.length; cIdx++) {
    const company = eligibleCompanies[cIdx]!;
    const extra = cIdx < remainder ? 1 : 0;
    const docCount = perCompanyBase + extra;

    for (let d = 0; d < docCount; d++) {
      const status = pickStatus();
      const docType = pick(rng, DOCUMENT_TYPE_POOL);
      const slug = slugify(company.name);
      // Stable file name so re-running the seed picks the same row.
      const fileName = `${slug}-${docType}-${d + 1}.pdf`;

      const reviewerEmail =
        status === "verified" || status === "rejected" || status === "expired"
          ? pick(rng, reviewerEmails)
          : null;
      const uploaderEmail = pick(rng, uploaderEmails);

      // Expiry profile: PAN cards never expire; others get a date.
      let expiresInDays: number | null;
      if (docType === "pan_card" || docType === "incorporation_cert") {
        expiresInDays = null;
      } else if (status === "expired") {
        // Past expiry — the cron has flipped it.
        if (pastExpiryBudget > 0) {
          pastExpiryBudget--;
          expiresInDays = -1 * int(rng, 30, 365);
        } else {
          expiresInDays = -1 * int(rng, 30, 365);
        }
      } else if (status === "verified" && nearExpiryBudget > 0 && rng() < 0.45) {
        nearExpiryBudget--;
        // In the 30-day reminder window.
        expiresInDays = int(rng, 1, 30);
      } else {
        // Verified-but-not-near; pending_review w/ future expiry.
        expiresInDays = int(rng, 90, 720);
      }

      const reviewNotes =
        status === "rejected"
          ? "Initial submission flagged for missing endorsements; reupload requested."
          : status === "verified" && reviewerEmail
            ? null
            : null;

      out.push({
        companyName: company.name,
        spec: {
          documentType: docType,
          fileName,
          status,
          sizeBytes: int(rng, 80_000, 2_000_000),
          mimeType: pick(rng, ["application/pdf", "image/jpeg", "image/png"] as const),
          issuedOn: `${int(rng, 2020, 2025)}-${String(int(rng, 1, 12)).padStart(2, "0")}-${String(int(rng, 1, 28)).padStart(2, "0")}`,
          expiresInDays,
          uploaderEmail,
          reviewerEmail,
          reviewNotes,
        },
      });
    }
  }

  return out;
}

// ── reminders_sent ────────────────────────────────────────────────────────

/**
 * Generate reminder rows for a slice of the generated documents that
 * carry `expiresInDays` inside the reminder window. The seed-plan
 * targets ~5 reminders in the large profile; the small profile only
 * needs ~2.
 *
 * Each row's `(documentId, reminderKind)` tuple is unique per the
 * schema's `reminders_sent_document_kind_unique_idx` index. The
 * generator picks distinct slots per document so the unique
 * constraint never trips.
 */
export interface GeneratedReminder {
  /** Company name — used to find the company id at insert time. */
  companyName: string;
  /** File name — used to find the document id under the company. */
  fileName: string;
  /** Reminder slot. */
  kind: "T-30" | "T-14" | "T-7" | "T-1";
  /** Days offset for the `sentAt` timestamp. */
  sentInDays: number;
}

export function generateReminders(
  scale: SeedScale,
  generatedDocs: Array<{ companyName: string; spec: DocumentSeed }>,
): GeneratedReminder[] {
  const profile = SEED_SCALE_PROFILES[scale];
  const target = profile.reminders;
  if (target === 0) return [];

  const rng = makePrng(505);
  // Pick documents inside the reminder window first.
  const inWindow = generatedDocs.filter(
    (d) =>
      d.spec.expiresInDays !== null &&
      d.spec.expiresInDays > 0 &&
      d.spec.expiresInDays <= 30 &&
      d.spec.status === "verified",
  );
  if (inWindow.length === 0) return [];

  const out: GeneratedReminder[] = [];
  for (let i = 0; i < target && i < inWindow.length; i++) {
    const doc = inWindow[i]!;
    // Slot = the bucket the doc actually sits in based on its days-to-expiry.
    const d2e = doc.spec.expiresInDays!;
    let kind: GeneratedReminder["kind"];
    if (d2e > 14) kind = "T-30";
    else if (d2e > 7) kind = "T-14";
    else if (d2e > 1) kind = "T-7";
    else kind = "T-1";
    out.push({
      companyName: doc.companyName,
      fileName: doc.spec.fileName,
      kind,
      sentInDays: -1 * int(rng, 0, 3),
    });
  }
  return out;
}

// ── Tenders / applications / projects / transactions (Chunk 4) ────────────
// Chunk-4 generators are appended at the bottom of this file in a
// separate session. The import surface above is stable.

export type GeneratedDocumentEntry = { companyName: string; spec: DocumentSeed };
