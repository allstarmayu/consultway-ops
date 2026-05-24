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
  type ProjectSeed,
  type SeedScale,
  type StandaloneSeed,
  type StaffUserSeed,
  type TenderApplicationSeed,
  type TenderSeed,
  type TransactionSeed,
} from "./seed";
import type {
  DocumentStatus,
  DocumentType,
  ProjectStatus,
  TenderApplicationStatus,
  TenderStatus,
  TransactionType,
} from "@/lib/db/schema";

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

// ── Tenders ──────────────────────────────────────────────────────────────

const TENDER_TITLE_POOL = [
  "Metro Corridor Civil Works",
  "Highway Expansion PMC",
  "Solar Rooftop Empanelment",
  "Smart City Infrastructure",
  "Airport Terminal Construction",
  "Sewage Treatment Plant",
  "Bridge Strengthening Programme",
  "Industrial Park Development",
  "Renewable Energy Park",
  "Coastal Defence Works",
  "Hospital Campus Construction",
  "Educational Campus Development",
  "Water Supply Network",
  "Power Transmission Line",
  "Logistics Hub Construction",
  "Stadium Renovation",
  "District Cooling System",
  "Cargo Terminal Expansion",
  "Cycle Track Network",
  "Municipal Park Redevelopment",
] as const;

/**
 * Generate the gap between the baseline tender count and the SEED_SCALE
 * target. Status mix matches the seed-plan: ~5 draft + ~12 published +
 * ~5 closed + ~3 awarded (scaled per profile).
 *
 * The generator emits ~22 published by the Consultway sentinel and
 * ~3 published by a real client company (sub-contracted). Eligibility
 * filters: ~8 with minAnnualTurnoverInr, ~5 with eligibleSector,
 * ~3 with msmeOnly.
 *
 * Awarded tenders get `awardedCompanyName` populated against a
 * randomly-picked compliant company — the matching application gets
 * `shortlisted` status in the next generator to satisfy the
 * state-machine precondition.
 */
export function generateTenders(
  scale: SeedScale,
  existingCount: number,
  generatedCompanies: StandaloneSeed[],
): TenderSeed[] {
  const profile = SEED_SCALE_PROFILES[scale];
  const need = Math.max(0, profile.tenders - existingCount);
  if (need === 0) return [];

  const rng = makePrng(606);
  const out: TenderSeed[] = [];

  // Status allocation that scales with `need`. Ratios per the seed-plan:
  //   5 draft + 12 published + 5 closed + 3 awarded = 25 total → fill
  //   the gap by the same proportions.
  const ratios: Array<{ status: TenderStatus; weight: number }> = [
    { status: "draft", weight: 4 },
    { status: "published", weight: 9 },
    { status: "closed", weight: 4 },
    { status: "awarded", weight: 2 },
  ];
  const totalW = ratios.reduce((s, r) => s + r.weight, 0);
  const allocations = ratios.map((r) => ({
    status: r.status,
    count: Math.round((r.weight / totalW) * need),
  }));
  // Sum drift correction onto the last bucket.
  const allocated = allocations.reduce((s, a) => s + a.count, 0);
  if (allocated !== need) {
    allocations[allocations.length - 1]!.count += need - allocated;
  }

  // Pool of compliant generated companies for the "awarded company" and
  // "sub-contracted publisher" picks. Falls back to baseline names when
  // the generated pool is empty.
  const compliantCompanies = generatedCompanies.filter(
    (c) => c.complianceStatus === "compliant",
  );

  let refIndex = 1;
  let titleIdx = 0;

  for (const a of allocations) {
    for (let i = 0; i < a.count; i++) {
      const baseTitle = TENDER_TITLE_POOL[titleIdx % TENDER_TITLE_POOL.length]!;
      const titleSuffix = Math.floor(titleIdx / TENDER_TITLE_POOL.length);
      const title =
        titleSuffix === 0
          ? `${baseTitle} (Lot ${refIndex})`
          : `${baseTitle} (Lot ${refIndex}) Round ${titleSuffix + 1}`;
      titleIdx++;

      const referenceNumber = `CW-2026-GEN-${String(refIndex).padStart(3, "0")}`;
      refIndex++;

      const sector = pick(rng, SECTOR_POOL);
      const geography = pick(rng, GEOGRAPHY_POOL);

      // Eligibility filter mix.
      const hasMinTurnover = rng() < 0.32; // ~8 of 25
      const hasEligibleSector = rng() < 0.2; // ~5 of 25
      const msmeOnly = rng() < 0.12; // ~3 of 25
      const eligibleGeography = rng() < 0.2 ? geography : null;

      const minAnnualTurnoverInr = hasMinTurnover
        ? Math.round(5_00_00_000 + rng() * 95_00_00_000) // ₹5–100 cr
        : null;

      // Awarded tenders need an awardee. Picked from compliant
      // generated companies; if that pool is empty, default to one
      // of the baseline-compliant standalones (Nimbus is the safest
      // bet — high turnover).
      const awardedCompanyName =
        a.status === "awarded"
          ? compliantCompanies.length > 0
            ? pick(rng, compliantCompanies).name
            : "Nimbus Infraworks"
          : null;

      // Date offsets per status.
      let openingInDays: number | null = null;
      let closingInDays: number | null = null;
      let publishedInDays: number | null = null;
      if (a.status === "draft") {
        // No publishing dates.
      } else if (a.status === "published") {
        openingInDays = -1 * int(rng, 7, 60);
        closingInDays = int(rng, 7, 90);
        publishedInDays = openingInDays;
      } else if (a.status === "closed") {
        openingInDays = -1 * int(rng, 60, 180);
        closingInDays = -1 * int(rng, 7, 45);
        publishedInDays = openingInDays;
      } else if (a.status === "awarded") {
        openingInDays = -1 * int(rng, 120, 240);
        closingInDays = -1 * int(rng, 60, 90);
        publishedInDays = openingInDays;
      }

      out.push({
        title,
        referenceNumber,
        status: a.status,
        description: `${baseTitle} — generated tender fixture for UAT coverage of the ${a.status} state.`,
        sector,
        geography,
        eligibleSector: hasEligibleSector ? sector : null,
        eligibleGeography,
        minAnnualTurnoverInr,
        msmeOnly,
        openingInDays,
        closingInDays,
        publishedInDays,
        awardedCompanyName,
        internalNotes:
          a.status === "draft"
            ? "Draft awaiting TOR finalisation."
            : a.status === "closed"
              ? "Closed pending board evaluation."
              : a.status === "awarded"
                ? "Awarded post evaluation cycle. Project promoted in Phase-3 flow."
                : null,
      });
    }
  }

  return out;
}

// ── Tender applications ──────────────────────────────────────────────────

/**
 * Generate applications for every published / closed / awarded tender.
 * 3–8 applications per tender, status mix per the seed-plan
 * (~40% submitted, ~20% shortlisted, ~20% rejected, ~15% withdrawn,
 * ~5% awarded reflected via the tender row's `awardedCompanyId`).
 *
 * For `awarded` tenders, the awardee company gets a `shortlisted`
 * application (the state-machine precondition to award).
 *
 * Idempotency comes from the DB-level UNIQUE (tenderId, companyId)
 * index. The generator picks each company at most once per tender.
 */
export function generateTenderApplications(
  scale: SeedScale,
  generatedTenders: TenderSeed[],
  generatedCompanies: StandaloneSeed[],
): TenderApplicationSeed[] {
  const rng = makePrng(707);
  const out: TenderApplicationSeed[] = [];

  // Pool of compliant standalone companies (generated + baseline names).
  // Baseline-compliant names that participate: Acme, BuildRight, Nimbus.
  // GreenTech is pending so excluded. Vertex is expired; Modern-Alpha is
  // non_compliant; Acme-BuildRight JV is compliant.
  const baselineCompanies = [
    "Acme Construction Pvt Ltd",
    "BuildRight Engineers",
    "Nimbus Infraworks",
    "Acme-BuildRight JV",
  ];
  const generatedCompliantNames = generatedCompanies
    .filter((c) => c.complianceStatus === "compliant")
    .map((c) => c.name);
  const companyPool = [...baselineCompanies, ...generatedCompliantNames];

  function pickStatusForGap(): TenderApplicationStatus {
    const r = rng();
    if (r < 0.45) return "submitted";
    if (r < 0.65) return "shortlisted";
    if (r < 0.85) return "rejected";
    return "withdrawn";
  }

  for (const t of generatedTenders) {
    if (t.status === "draft") continue;

    // Decide how many applications this tender receives.
    const n = int(rng, 3, 8);

    // Shuffle the company pool deterministically for this tender.
    const shuffled = [...companyPool].sort(() => rng() - 0.5);
    const picks = shuffled.slice(0, Math.min(n, shuffled.length));

    // For awarded tenders, ensure the awardee is in the picks AND gets
    // a `shortlisted` status (the state-machine precondition).
    if (t.status === "awarded" && t.awardedCompanyName) {
      if (!picks.includes(t.awardedCompanyName)) {
        picks.push(t.awardedCompanyName);
      }
    }

    for (const companyName of picks) {
      const status =
        t.status === "awarded" && companyName === t.awardedCompanyName
          ? ("shortlisted" as const)
          : pickStatusForGap();

      const submittedInDays = -1 * int(rng, 7, 60);
      const decidedInDays =
        status === "submitted" ? null : submittedInDays + int(rng, 1, 30);

      out.push({
        tenderReferenceNumber: t.referenceNumber,
        companyName,
        status,
        coverNote: `${companyName} cover note for tender ${t.referenceNumber}.`,
        internalNotes: null,
        submittedInDays,
        decidedInDays,
      });
    }
  }

  return out;
}

// ── Projects ─────────────────────────────────────────────────────────────

const PROJECT_KIND_POOL = [
  "Infrastructure Build",
  "Civil PMC",
  "Solar Park Consulting",
  "Highway Maintenance",
  "Smart City Advisory",
  "Site Survey",
  "Bridge Strengthening",
  "Water Supply Network",
  "Hospital Build",
  "Industrial Park Development",
] as const;

/**
 * Generate projects on top of the baseline. ~40% of generated rows are
 * promoted from awarded tenders (tenderId populated); the rest are
 * standalone direct-creates.
 *
 * Idempotency: `(companyId, name)`. The generator embeds the company
 * slug + a stable index in the name so re-runs hit the same row.
 */
export function generateProjects(
  scale: SeedScale,
  existingCount: number,
  generatedCompanies: StandaloneSeed[],
  generatedTenders: TenderSeed[],
): ProjectSeed[] {
  const profile = SEED_SCALE_PROFILES[scale];
  const need = Math.max(0, profile.projects - existingCount);
  if (need === 0) return [];

  const rng = makePrng(808);
  const out: ProjectSeed[] = [];

  const ratios: Array<{ status: ProjectStatus; weight: number }> = [
    { status: "planning", weight: 4 },
    { status: "active", weight: 9 },
    { status: "on_hold", weight: 2 },
    { status: "completed", weight: 4 },
    { status: "cancelled", weight: 1 },
  ];
  const totalW = ratios.reduce((s, r) => s + r.weight, 0);
  const allocations = ratios.map((r) => ({
    status: r.status,
    count: Math.round((r.weight / totalW) * need),
  }));
  const allocated = allocations.reduce((s, a) => s + a.count, 0);
  if (allocated !== need) {
    allocations[allocations.length - 1]!.count += need - allocated;
  }

  const operationalCompanies = generatedCompanies.filter(
    (c) => c.complianceStatus === "compliant",
  );
  if (operationalCompanies.length === 0) return out;

  const awardedTenders = generatedTenders.filter((t) => t.status === "awarded");

  // ~10 projects promoted from a tender (large profile). Distribute
  // across the awarded set; if there aren't enough awarded tenders,
  // re-use them — Phase-3 doesn't enforce 1:1 in the schema.
  const promoteBudget = Math.min(
    awardedTenders.length * 2,
    Math.round(need * 0.4),
  );
  let promoted = 0;
  let companyIdx = 0;
  let nameIdx = 0;

  for (const a of allocations) {
    for (let i = 0; i < a.count; i++) {
      // Round-robin the compliant company pool so projects spread.
      const company = operationalCompanies[companyIdx % operationalCompanies.length]!;
      companyIdx++;

      const shouldPromote =
        promoted < promoteBudget && awardedTenders.length > 0 && rng() < 0.5;
      const tenderRef = shouldPromote
        ? awardedTenders[promoted % awardedTenders.length]!.referenceNumber
        : null;
      if (shouldPromote) promoted++;

      const kind = pick(rng, PROJECT_KIND_POOL);
      const slug = slugify(company.name);
      const name = `${kind} for ${company.name} (#${nameIdx + 1})`;
      nameIdx++;

      // Budget: lakh-range (₹10-50 lakh) or crore-range (₹1-15 cr).
      // The seed-plan calls for ~20 of 25 budgets populated; pick by
      // probability so the generator emits ~80% with budgets.
      const hasBudget = rng() < 0.8;
      const isCrore = hasBudget && rng() < 0.35;
      const budgetInr = !hasBudget
        ? null
        : isCrore
          ? Math.round(1_00_00_000 + rng() * 14_00_00_000)
          : Math.round(10_00_000 + rng() * 40_00_000);

      // Date offsets by status.
      let startInDays: number | null = null;
      let endInDays: number | null = null;
      if (a.status === "planning") {
        startInDays = int(rng, 15, 90);
      } else if (a.status === "active") {
        startInDays = -1 * int(rng, 7, 90);
        endInDays = int(rng, 30, 180);
      } else if (a.status === "on_hold") {
        startInDays = -1 * int(rng, 30, 120);
        endInDays = int(rng, 30, 120);
      } else if (a.status === "completed") {
        startInDays = -1 * int(rng, 180, 365);
        endInDays = -1 * int(rng, 7, 60);
      } else if (a.status === "cancelled") {
        startInDays = -1 * int(rng, 60, 180);
        endInDays = -1 * int(rng, 30, 60);
      }

      // Reference slug to suppress lint warnings about unused vars.
      void slug;

      out.push({
        name,
        companyName: company.name,
        tenderReferenceNumber: tenderRef,
        status: a.status,
        description: `Generated ${kind.toLowerCase()} engagement for ${company.name}.`,
        startInDays,
        endInDays,
        budgetInr,
        internalNotes:
          a.status === "on_hold"
            ? "Paused pending external clearance."
            : a.status === "cancelled"
              ? "Cancellation triggered by client scope change."
              : null,
      });
    }
  }

  return out;
}

// ── Transactions ─────────────────────────────────────────────────────────

/**
 * Generate ~230 (large) transactions spread across the last 12 months.
 * Type mix: 30% invoice / 30% payment / 20% expense / 10% advance /
 * 10% refund. ~60% project-linked (cross-FK invariant enforced — pick
 * the company FIRST, then a random project owned by that company).
 *
 * Reference numbers prefixed by type + an index so the
 * `(companyId, referenceNumber)` natural-key idempotency holds.
 *
 * All amounts/dates use the deterministic PRNG so re-running the seed
 * lands every row as `unchanged` (per the self-healing contract).
 */
export function generateTransactions(
  scale: SeedScale,
  existingCount: number,
  generatedCompanies: StandaloneSeed[],
  generatedProjects: ProjectSeed[],
): TransactionSeed[] {
  const profile = SEED_SCALE_PROFILES[scale];
  const need = Math.max(0, profile.transactions - existingCount);
  if (need === 0) return [];

  const rng = makePrng(909);
  const out: TransactionSeed[] = [];

  function pickType(): TransactionType {
    const r = rng();
    if (r < 0.3) return "invoice";
    if (r < 0.6) return "payment";
    if (r < 0.8) return "expense";
    if (r < 0.9) return "advance";
    return "refund";
  }

  function pickAmount(): number {
    // 60% lakh-range, 30% thousands-range, 10% crore-range.
    const r = rng();
    if (r < 0.6) {
      // ₹50,000 – ₹50,00,000 in paise
      return Math.round(50_000 + rng() * 49_50_000) * 100;
    }
    if (r < 0.9) {
      // ₹5,000 – ₹50,000 in paise
      return Math.round(5_000 + rng() * 45_000) * 100;
    }
    // ₹1,00,00,000 – ₹10,00,00,000 in paise (₹1 cr – ₹10 cr)
    return Math.round(1_00_00_000 + rng() * 9_00_00_000) * 100;
  }

  // Pool of companies that have projects (for project-linked txns).
  // The cross-FK invariant requires (companyName == project.companyName).
  // Build a map: companyName -> projects, so we can do "pick a project,
  // get its company" safely.
  const projectsByCompany = new Map<string, ProjectSeed[]>();
  for (const p of generatedProjects) {
    const arr = projectsByCompany.get(p.companyName) ?? [];
    arr.push(p);
    projectsByCompany.set(p.companyName, arr);
  }
  const companiesWithProjects = Array.from(projectsByCompany.keys());

  // Pool of companies for company-level (no project) txns.
  // Generated compliant + all baseline names.
  const baselineCompanies = [
    "Acme Construction Pvt Ltd",
    "BuildRight Engineers",
    "GreenTech Solutions",
    "Nimbus Infraworks",
    "Acme-BuildRight JV",
  ];
  const allCompanyNames = [
    ...generatedCompanies.filter((c) => c.complianceStatus === "compliant").map((c) => c.name),
    ...baselineCompanies,
  ];

  for (let i = 0; i < need; i++) {
    const type = pickType();
    const isProjectLinked = rng() < 0.6 && companiesWithProjects.length > 0;

    let companyName: string;
    let projectName: string | null;
    if (isProjectLinked) {
      companyName = pick(rng, companiesWithProjects);
      const candidates = projectsByCompany.get(companyName)!;
      projectName = pick(rng, candidates).name;
    } else {
      companyName = pick(rng, allCompanyNames);
      projectName = null;
    }

    // Spread `occurredOn` across the last 12 months. ~20/month with
    // some jitter so the report period cards have non-zero counts at
    // every period window.
    const monthsAgo = Math.floor(i / Math.max(1, Math.floor(need / 12)));
    const dayJitter = int(rng, 0, 28);
    const occurredInDays = -1 * (monthsAgo * 30 + dayJitter);

    const prefix = type.slice(0, 3).toUpperCase();
    const referenceNumber = `GEN-${prefix}-${String(i + 1).padStart(4, "0")}`;

    out.push({
      type,
      amountPaise: pickAmount(),
      companyName,
      projectName,
      occurredInDays,
      referenceNumber,
      notes: projectName
        ? `Generated ${type} for project ${projectName}.`
        : `Generated company-level ${type} for ${companyName}.`,
    });
  }

  return out;
}

export type GeneratedDocumentEntry = { companyName: string; spec: DocumentSeed };
