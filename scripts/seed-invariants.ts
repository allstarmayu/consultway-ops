/**
 * Seed-invariant verifier.
 *
 * Read-only audit pass over the seeded DB that re-asserts the invariants
 * the schema can't express. The seed itself enforces most of these at
 * insert time, but the verifier acts as a tripwire — if a future fixture
 * change or a bug in a seeder produces a silently-bad row, this catches
 * it before the operator browses to the dashboard and finds a broken UI.
 *
 * Invariants checked (in order):
 *   1. Cross-FK: every project-linked transaction's `companyId` matches
 *      the linked project's `companyId`. The schema can't express the
 *      join-key equality as a constraint.
 *   2. Every `complianceStatus = 'rejected'` company has a non-null
 *      `rejectionReason` populated.
 *   3. Every `tenders.status = 'awarded'` row has a non-null
 *      `awardedCompanyId` populated.
 *   4. Every `tender_applications` row's `(tenderId, companyId)` tuple
 *      is unique. (The DB-level UNIQUE index already enforces this; the
 *      check is belt-and-braces against a hypothetical schema drift.)
 *   5. Every `reminders_sent` row's `(documentId, reminderKind)` tuple
 *      is unique. Same belt-and-braces rationale.
 *   6. No orphan FKs — every foreign-key column resolves to an existing
 *      parent row.
 *   7. Every enum-typed column carries a value in its known union.
 *
 * Usage:
 *
 *   import { runInvariantChecks } from "./seed-invariants";
 *   const result = await runInvariantChecks(db);
 *   if (!result.passed) { ... }
 *
 * As a CLI:
 *
 *   pnpm seed:verify
 *
 * Exits 0 on clean, 1 on any failure. On failure, the script prints up
 * to 5 sample violating row ids per invariant + the human-readable
 * description.
 *
 * @module scripts/seed-invariants
 */
import "dotenv/config";
import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import {
  auditLog,
  companies,
  documents,
  emailVerificationTokens,
  passwordResetTokens,
  projects,
  remindersSent,
  tenderApplications,
  tenders,
  transactions,
  users,
  type ComplianceStatus,
  type DocumentStatus,
  type DocumentType,
  type ProjectStatus,
  type ReminderKind,
  type TenderApplicationStatus,
  type TenderStatus,
  type TransactionType,
  type UserRole,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "seed-invariants" });

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * A single invariant violation. `sample` carries up to 5 row ids (or
 * row-identifying composites) so a human can grep for them in the seed
 * fixtures or the DB.
 */
export interface InvariantViolation {
  /** Short stable name; CLI prints it. */
  name: string;
  /** Human-readable explanation of what failed. */
  description: string;
  /** Total count of violating rows (or NaN for unbounded). */
  count: number;
  /** Up to 5 sample violating row ids / composites. */
  sample: string[];
}

export interface InvariantCheckResult {
  passed: boolean;
  violations: InvariantViolation[];
}

/**
 * Drizzle DB instance. Typed loosely so the helper accepts both the
 * dev-time `better-sqlite3` Drizzle and any future D1 variant.
 */
type Db = typeof defaultDb;

// ── Enum value sets ───────────────────────────────────────────────────────

/**
 * Re-declares the union values as runtime arrays so the verifier can
 * test membership. Kept in lockstep with `lib/db/schema.ts` by hand
 * (same convention as `complianceStatusSchema` in
 * `lib/companies/schemas.ts` — Zod's `z.enum()` needs literal values at
 * compile time and TypeScript types vanish at runtime).
 */
const COMPLIANCE_STATUS_VALUES: ComplianceStatus[] = [
  "pending",
  "compliant",
  "non_compliant",
  "expired",
  "suspended",
  "rejected",
];

const DOCUMENT_STATUS_VALUES: DocumentStatus[] = [
  "pending",
  "pending_review",
  "verified",
  "rejected",
  "expired",
];

const DOCUMENT_TYPE_VALUES: DocumentType[] = [
  "gst_certificate",
  "pan_card",
  "incorporation_cert",
  "board_resolution",
  "cancelled_cheque",
  "trade_license",
  "other",
];

const TENDER_STATUS_VALUES: TenderStatus[] = [
  "draft",
  "published",
  "closed",
  "awarded",
];

const TENDER_APPLICATION_STATUS_VALUES: TenderApplicationStatus[] = [
  "submitted",
  "withdrawn",
  "shortlisted",
  "rejected",
];

const PROJECT_STATUS_VALUES: ProjectStatus[] = [
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
];

const TRANSACTION_TYPE_VALUES: TransactionType[] = [
  "invoice",
  "payment",
  "expense",
  "advance",
  "refund",
];

const REMINDER_KIND_VALUES: ReminderKind[] = ["T-30", "T-14", "T-7", "T-1"];

const USER_ROLE_VALUES: UserRole[] = ["admin", "staff", "company"];

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Cap the sample list at 5 ids — enough to grep for, not so many the
 * CLI output drowns. Sorted for stable printing.
 */
function sampleIds(ids: string[], cap = 5): string[] {
  return [...ids].sort().slice(0, cap);
}

/**
 * Build a violation with a clipped sample.
 */
function makeViolation(
  name: string,
  description: string,
  ids: string[],
): InvariantViolation {
  return {
    name,
    description,
    count: ids.length,
    sample: sampleIds(ids),
  };
}

// ── Individual invariant checks ───────────────────────────────────────────

async function checkCrossFkTransactionProject(db: Db): Promise<InvariantViolation | null> {
  // Pull every project-linked transaction and the project's companyId.
  // Single LEFT JOIN; no per-row N+1.
  const rows = await db
    .select({
      txnId: transactions.id,
      txnCompanyId: transactions.companyId,
      projectCompanyId: projects.companyId,
    })
    .from(transactions)
    .leftJoin(projects, eq(transactions.projectId, projects.id))
    .where(isNotNull(transactions.projectId));

  const bad = rows
    .filter((r) => r.projectCompanyId !== r.txnCompanyId)
    .map((r) => r.txnId);
  if (bad.length === 0) return null;
  return makeViolation(
    "transactions.cross_fk",
    "Project-linked transactions whose companyId differs from the linked project's companyId.",
    bad,
  );
}

async function checkRejectedHasReason(db: Db): Promise<InvariantViolation | null> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(eq(companies.complianceStatus, "rejected"), isNull(companies.rejectionReason)),
    );
  if (rows.length === 0) return null;
  return makeViolation(
    "companies.rejected_reason_missing",
    "Companies in `rejected` compliance status without a populated rejectionReason.",
    rows.map((r) => r.id),
  );
}

async function checkAwardedHasCompany(db: Db): Promise<InvariantViolation | null> {
  const rows = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(and(eq(tenders.status, "awarded"), isNull(tenders.awardedCompanyId)));
  if (rows.length === 0) return null;
  return makeViolation(
    "tenders.awarded_company_missing",
    "Tenders in `awarded` status without a populated awardedCompanyId.",
    rows.map((r) => r.id),
  );
}

async function checkApplicationUnique(db: Db): Promise<InvariantViolation | null> {
  // Aggregate count per (tenderId, companyId); flag any > 1.
  const rows = await db
    .select({
      tenderId: tenderApplications.tenderId,
      companyId: tenderApplications.companyId,
      n: sql<number>`count(*)`,
    })
    .from(tenderApplications)
    .groupBy(tenderApplications.tenderId, tenderApplications.companyId);
  const dupes = rows.filter((r) => Number(r.n) > 1);
  if (dupes.length === 0) return null;
  return makeViolation(
    "tender_applications.duplicate",
    "Duplicate (tenderId, companyId) tuples in tender_applications.",
    dupes.map((r) => `${r.tenderId}::${r.companyId}`),
  );
}

async function checkReminderUnique(db: Db): Promise<InvariantViolation | null> {
  const rows = await db
    .select({
      documentId: remindersSent.documentId,
      kind: remindersSent.reminderKind,
      n: sql<number>`count(*)`,
    })
    .from(remindersSent)
    .groupBy(remindersSent.documentId, remindersSent.reminderKind);
  const dupes = rows.filter((r) => Number(r.n) > 1);
  if (dupes.length === 0) return null;
  return makeViolation(
    "reminders_sent.duplicate",
    "Duplicate (documentId, reminderKind) tuples in reminders_sent.",
    dupes.map((r) => `${r.documentId}::${r.kind}`),
  );
}

/**
 * Orphan-FK detection: for each FK column we care about, list rows
 * whose pointed-at id doesn't exist in the parent table. Done as a
 * left-anti-join via `NOT IN` against the set of valid parent ids —
 * SQLite optimises this against the parent's primary-key index.
 *
 * The check covers FKs that aren't already strictly enforced by the
 * DB (NULL FKs that point to deleted rows would surface here even
 * with `PRAGMA foreign_keys = ON`, since SET NULL drops the value
 * cleanly). Belt-and-braces against a hypothetical bypass via
 * direct SQL inserts during demos.
 */
async function checkOrphans(db: Db): Promise<InvariantViolation[]> {
  const out: InvariantViolation[] = [];

  // users.companyId -> companies.id (nullable; only check non-null rows)
  const userRows = await db
    .select({ id: users.id, companyId: users.companyId })
    .from(users)
    .where(isNotNull(users.companyId));
  const allCompanyIds = (await db.select({ id: companies.id }).from(companies)).map(
    (r) => r.id,
  );
  const orphanUsers = userRows
    .filter((u) => u.companyId && !allCompanyIds.includes(u.companyId))
    .map((u) => u.id);
  if (orphanUsers.length) {
    out.push(
      makeViolation(
        "users.orphan_company",
        "Users whose companyId doesn't resolve to an existing company.",
        orphanUsers,
      ),
    );
  }

  // documents.companyId / uploadedBy / reviewedBy
  const docRows = await db
    .select({
      id: documents.id,
      companyId: documents.companyId,
      uploadedBy: documents.uploadedBy,
      reviewedBy: documents.reviewedBy,
    })
    .from(documents);
  const allUserIds = (await db.select({ id: users.id }).from(users)).map((r) => r.id);

  const orphanDocCompany = docRows
    .filter((d) => !allCompanyIds.includes(d.companyId))
    .map((d) => d.id);
  if (orphanDocCompany.length) {
    out.push(
      makeViolation(
        "documents.orphan_company",
        "Documents whose companyId doesn't resolve to an existing company.",
        orphanDocCompany,
      ),
    );
  }
  const orphanDocUploader = docRows
    .filter((d) => !allUserIds.includes(d.uploadedBy))
    .map((d) => d.id);
  if (orphanDocUploader.length) {
    out.push(
      makeViolation(
        "documents.orphan_uploader",
        "Documents whose uploadedBy doesn't resolve to an existing user.",
        orphanDocUploader,
      ),
    );
  }
  const orphanDocReviewer = docRows
    .filter((d) => d.reviewedBy !== null && !allUserIds.includes(d.reviewedBy))
    .map((d) => d.id);
  if (orphanDocReviewer.length) {
    out.push(
      makeViolation(
        "documents.orphan_reviewer",
        "Documents whose reviewedBy doesn't resolve to an existing user.",
        orphanDocReviewer,
      ),
    );
  }

  // tenders.publisherCompanyId + awardedCompanyId
  const tenderRows = await db
    .select({
      id: tenders.id,
      publisherCompanyId: tenders.publisherCompanyId,
      awardedCompanyId: tenders.awardedCompanyId,
    })
    .from(tenders);
  const orphanTenderPublisher = tenderRows
    .filter((t) => !allCompanyIds.includes(t.publisherCompanyId))
    .map((t) => t.id);
  if (orphanTenderPublisher.length) {
    out.push(
      makeViolation(
        "tenders.orphan_publisher",
        "Tenders whose publisherCompanyId doesn't resolve to an existing company.",
        orphanTenderPublisher,
      ),
    );
  }
  const orphanTenderAwardee = tenderRows
    .filter((t) => t.awardedCompanyId !== null && !allCompanyIds.includes(t.awardedCompanyId))
    .map((t) => t.id);
  if (orphanTenderAwardee.length) {
    out.push(
      makeViolation(
        "tenders.orphan_awardee",
        "Tenders whose awardedCompanyId doesn't resolve to an existing company.",
        orphanTenderAwardee,
      ),
    );
  }

  // tender_applications.tenderId + companyId
  const allTenderIds = (await db.select({ id: tenders.id }).from(tenders)).map((r) => r.id);
  const appRows = await db
    .select({
      id: tenderApplications.id,
      tenderId: tenderApplications.tenderId,
      companyId: tenderApplications.companyId,
    })
    .from(tenderApplications);
  const orphanAppTender = appRows
    .filter((a) => !allTenderIds.includes(a.tenderId))
    .map((a) => a.id);
  if (orphanAppTender.length) {
    out.push(
      makeViolation(
        "tender_applications.orphan_tender",
        "Tender applications whose tenderId doesn't resolve to an existing tender.",
        orphanAppTender,
      ),
    );
  }
  const orphanAppCompany = appRows
    .filter((a) => !allCompanyIds.includes(a.companyId))
    .map((a) => a.id);
  if (orphanAppCompany.length) {
    out.push(
      makeViolation(
        "tender_applications.orphan_company",
        "Tender applications whose companyId doesn't resolve to an existing company.",
        orphanAppCompany,
      ),
    );
  }

  // projects.companyId + tenderId
  const projectRows = await db
    .select({
      id: projects.id,
      companyId: projects.companyId,
      tenderId: projects.tenderId,
    })
    .from(projects);
  const orphanProjectCompany = projectRows
    .filter((p) => !allCompanyIds.includes(p.companyId))
    .map((p) => p.id);
  if (orphanProjectCompany.length) {
    out.push(
      makeViolation(
        "projects.orphan_company",
        "Projects whose companyId doesn't resolve to an existing company.",
        orphanProjectCompany,
      ),
    );
  }
  const orphanProjectTender = projectRows
    .filter((p) => p.tenderId !== null && !allTenderIds.includes(p.tenderId))
    .map((p) => p.id);
  if (orphanProjectTender.length) {
    out.push(
      makeViolation(
        "projects.orphan_tender",
        "Projects whose tenderId doesn't resolve to an existing tender.",
        orphanProjectTender,
      ),
    );
  }

  // transactions.companyId + projectId
  const allProjectIds = (await db.select({ id: projects.id }).from(projects)).map((r) => r.id);
  const txnRows = await db
    .select({
      id: transactions.id,
      companyId: transactions.companyId,
      projectId: transactions.projectId,
    })
    .from(transactions);
  const orphanTxnCompany = txnRows
    .filter((t) => !allCompanyIds.includes(t.companyId))
    .map((t) => t.id);
  if (orphanTxnCompany.length) {
    out.push(
      makeViolation(
        "transactions.orphan_company",
        "Transactions whose companyId doesn't resolve to an existing company.",
        orphanTxnCompany,
      ),
    );
  }
  const orphanTxnProject = txnRows
    .filter((t) => t.projectId !== null && !allProjectIds.includes(t.projectId))
    .map((t) => t.id);
  if (orphanTxnProject.length) {
    out.push(
      makeViolation(
        "transactions.orphan_project",
        "Transactions whose projectId doesn't resolve to an existing project.",
        orphanTxnProject,
      ),
    );
  }

  // reminders_sent.documentId
  const allDocIds = (await db.select({ id: documents.id }).from(documents)).map(
    (r) => r.id,
  );
  const reminderRows = await db
    .select({ id: remindersSent.id, documentId: remindersSent.documentId })
    .from(remindersSent);
  const orphanReminderDoc = reminderRows
    .filter((r) => !allDocIds.includes(r.documentId))
    .map((r) => r.id);
  if (orphanReminderDoc.length) {
    out.push(
      makeViolation(
        "reminders_sent.orphan_document",
        "reminders_sent rows whose documentId doesn't resolve to an existing document.",
        orphanReminderDoc,
      ),
    );
  }

  // email_verification_tokens.userId + password_reset_tokens.userId
  const evtRows = await db
    .select({ id: emailVerificationTokens.id, userId: emailVerificationTokens.userId })
    .from(emailVerificationTokens);
  const orphanEvt = evtRows
    .filter((r) => !allUserIds.includes(r.userId))
    .map((r) => r.id);
  if (orphanEvt.length) {
    out.push(
      makeViolation(
        "email_verification_tokens.orphan_user",
        "Email-verification tokens whose userId doesn't resolve to an existing user.",
        orphanEvt,
      ),
    );
  }
  const prtRows = await db
    .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId })
    .from(passwordResetTokens);
  const orphanPrt = prtRows
    .filter((r) => !allUserIds.includes(r.userId))
    .map((r) => r.id);
  if (orphanPrt.length) {
    out.push(
      makeViolation(
        "password_reset_tokens.orphan_user",
        "Password-reset tokens whose userId doesn't resolve to an existing user.",
        orphanPrt,
      ),
    );
  }

  return out;
}

/**
 * Enum-value check. Goes table-by-table, looks for any value not in the
 * known union for each enum-typed column. SQLite stores them as TEXT
 * without a CHECK constraint, so a typo'd fixture would survive an
 * INSERT — the seed catches its own typos via TypeScript, but an
 * external SQL session wouldn't.
 */
async function checkEnumValues(db: Db): Promise<InvariantViolation[]> {
  const out: InvariantViolation[] = [];

  const badCompanies = await db
    .select({ id: companies.id, status: companies.complianceStatus })
    .from(companies)
    .where(notInArray(companies.complianceStatus, COMPLIANCE_STATUS_VALUES));
  if (badCompanies.length) {
    out.push(
      makeViolation(
        "companies.bad_compliance_status",
        "Companies whose complianceStatus is not in the known union.",
        badCompanies.map((r) => `${r.id} (=${r.status})`),
      ),
    );
  }

  const badUsers = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(notInArray(users.role, USER_ROLE_VALUES));
  if (badUsers.length) {
    out.push(
      makeViolation(
        "users.bad_role",
        "Users whose role is not in the known union.",
        badUsers.map((r) => `${r.id} (=${r.role})`),
      ),
    );
  }

  const badDocStatus = await db
    .select({ id: documents.id, status: documents.status })
    .from(documents)
    .where(notInArray(documents.status, DOCUMENT_STATUS_VALUES));
  if (badDocStatus.length) {
    out.push(
      makeViolation(
        "documents.bad_status",
        "Documents whose status is not in the known union.",
        badDocStatus.map((r) => `${r.id} (=${r.status})`),
      ),
    );
  }

  const badDocType = await db
    .select({ id: documents.id, type: documents.documentType })
    .from(documents)
    .where(notInArray(documents.documentType, DOCUMENT_TYPE_VALUES));
  if (badDocType.length) {
    out.push(
      makeViolation(
        "documents.bad_type",
        "Documents whose documentType is not in the known union.",
        badDocType.map((r) => `${r.id} (=${r.type})`),
      ),
    );
  }

  const badTenderStatus = await db
    .select({ id: tenders.id, status: tenders.status })
    .from(tenders)
    .where(notInArray(tenders.status, TENDER_STATUS_VALUES));
  if (badTenderStatus.length) {
    out.push(
      makeViolation(
        "tenders.bad_status",
        "Tenders whose status is not in the known union.",
        badTenderStatus.map((r) => `${r.id} (=${r.status})`),
      ),
    );
  }

  const badAppStatus = await db
    .select({ id: tenderApplications.id, status: tenderApplications.status })
    .from(tenderApplications)
    .where(notInArray(tenderApplications.status, TENDER_APPLICATION_STATUS_VALUES));
  if (badAppStatus.length) {
    out.push(
      makeViolation(
        "tender_applications.bad_status",
        "Tender applications whose status is not in the known union.",
        badAppStatus.map((r) => `${r.id} (=${r.status})`),
      ),
    );
  }

  const badProjectStatus = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(notInArray(projects.status, PROJECT_STATUS_VALUES));
  if (badProjectStatus.length) {
    out.push(
      makeViolation(
        "projects.bad_status",
        "Projects whose status is not in the known union.",
        badProjectStatus.map((r) => `${r.id} (=${r.status})`),
      ),
    );
  }

  const badTxnType = await db
    .select({ id: transactions.id, type: transactions.type })
    .from(transactions)
    .where(notInArray(transactions.type, TRANSACTION_TYPE_VALUES));
  if (badTxnType.length) {
    out.push(
      makeViolation(
        "transactions.bad_type",
        "Transactions whose type is not in the known union.",
        badTxnType.map((r) => `${r.id} (=${r.type})`),
      ),
    );
  }

  const badReminderKind = await db
    .select({ id: remindersSent.id, kind: remindersSent.reminderKind })
    .from(remindersSent)
    .where(notInArray(remindersSent.reminderKind, REMINDER_KIND_VALUES));
  if (badReminderKind.length) {
    out.push(
      makeViolation(
        "reminders_sent.bad_kind",
        "reminders_sent rows whose reminderKind is not in the known union.",
        badReminderKind.map((r) => `${r.id} (=${r.kind})`),
      ),
    );
  }

  return out;
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Run every invariant check against the supplied db. Returns the full
 * list of violations (callers that want fail-fast can `if (!passed)`).
 */
export async function runInvariantChecks(db: Db = defaultDb): Promise<InvariantCheckResult> {
  const violations: InvariantViolation[] = [];

  const v1 = await checkCrossFkTransactionProject(db);
  if (v1) violations.push(v1);
  const v2 = await checkRejectedHasReason(db);
  if (v2) violations.push(v2);
  const v3 = await checkAwardedHasCompany(db);
  if (v3) violations.push(v3);
  const v4 = await checkApplicationUnique(db);
  if (v4) violations.push(v4);
  const v5 = await checkReminderUnique(db);
  if (v5) violations.push(v5);
  violations.push(...(await checkOrphans(db)));
  violations.push(...(await checkEnumValues(db)));

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("seed-invariants starting");
  const result = await runInvariantChecks(defaultDb);

  if (result.passed) {
    log.info("seed-invariants clean", { violations: 0 });
    // eslint-disable-next-line no-console
    console.log("\n✓ All invariants pass.\n");
    return;
  }

  log.error("seed-invariants found violations", {
    violationCount: result.violations.length,
  });
  // eslint-disable-next-line no-console
  console.error("\n✗ Invariant violations:\n");
  for (const v of result.violations) {
    // eslint-disable-next-line no-console
    console.error(`  [${v.name}] ${v.description}`);
    // eslint-disable-next-line no-console
    console.error(`    count: ${v.count}`);
    // eslint-disable-next-line no-console
    console.error(`    sample: ${v.sample.join(", ")}\n`);
  }
  process.exit(1);
}

// Skip the CLI when imported by tests.
if (!process.env.VITEST) {
  main().catch((err) => {
    log.error("seed-invariants crashed", { err });
    process.exit(1);
  });
}
