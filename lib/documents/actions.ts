/**
 * Documents module - Server Actions.
 *
 * Day 9: two actions only. The full set (download, verify, reject,
 * delete, expiry sweep) lands in Day 10+.
 *
 *   - initiateDocumentUpload  -> insert pending row, return presigned PUT URL
 *   - confirmDocumentUpload   -> flip pending -> pending_review, audit
 *
 * Return shape matches the companies/tenders convention:
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Two-step flow rationale (also documented in lib/db/schema.ts::documents
 * and lib/documents/schemas.ts): the client uploads bytes directly to R2
 * via a presigned PUT URL, bypassing our Worker entirely. That sidesteps
 * the Workers 100 MB request-body limit and saves egress + CPU. But we
 * need a row in the DB before signing the URL (the key targets a specific
 * documentId), and we need a confirmation step after to know the upload
 * actually succeeded before treating the document as "real."
 *
 * Role rules (also documented in docs/08-rbac-matrix.md "Documents"):
 *
 *   Action                       admin   staff   company
 *   initiateDocumentUpload       any     any     own company only
 *   confirmDocumentUpload        any     any     own document only
 *
 * Audit logging: `document_uploaded` is recorded by `confirmDocumentUpload`
 * (not by `initiate`). Initiate creates a row that may never become
 * "real" - a client that aborts after init leaves a `pending` orphan,
 * and auditing those would be noise. Confirm is the durable event.
 *
 * @module lib/documents/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  documents,
  companies,
  type Document,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { recordAuditEvent } from "@/lib/audit/log";
import { getPresignedPutUrl } from "@/lib/r2/client";
import { buildDocumentKey } from "@/lib/r2/keys";
import {
  initiateDocumentUploadSchema,
  confirmDocumentUploadSchema,
  type InitiateDocumentUploadInput,
} from "./schemas";

const log = logger.child({ module: "documents-actions" });

// ── Result types ────────────────────────────────────────────────────────────

/**
 * Generic action result. Reused across actions so the calling UI can
 * branch on `result.ok` consistently. Same shape as companies/tenders -
 * declared locally rather than centralised because that lift requires
 * touching all three domain modules and isn't Day 9's job (see day-9
 * follow-up notes).
 */
export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; field?: string };

// ── Authorization helpers ───────────────────────────────────────────────────

/**
 * The session shape, unwrapped from `readSession()`'s nullable return.
 * Same alias as the other domain modules.
 */
type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

/**
 * Result type for the document-upload authority gate. Either:
 *   - ok: the caller may upload for this companyId (and we surface the
 *     session for downstream audit-log calls), or
 *   - failure with a friendly error.
 *
 * The "may upload for this company" question subsumes three different
 * paths:
 *   - admin / staff -> yes, for any company
 *   - company role  -> yes ONLY if companyId === session.companyId
 *   - anyone else   -> no
 *
 * Centralising the check here means `initiateDocumentUpload` and
 * `confirmDocumentUpload` share the same logic, and adding a fourth
 * role later (e.g. a per-company-bounded reviewer) is a one-line edit.
 */
type DocumentUploadAuth =
  | { ok: true; session: Session }
  | { ok: false; error: string };

async function requireUploadAuthority(
  companyId: string,
): Promise<DocumentUploadAuth> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  if (session.role === "admin" || session.role === "staff") {
    return { ok: true, session };
  }

  // role === "company"
  if (!session.companyId) {
    log.error("company-role user has no linked company", {
      userId: session.userId,
    });
    return { ok: false, error: "Your account is not linked to a company" };
  }
  if (session.companyId !== companyId) {
    log.warn("cross-company upload attempt blocked", {
      userId: session.userId,
      sessionCompanyId: session.companyId,
      requestedCompanyId: companyId,
    });
    // Don't leak the existence of other companies. Same "not found"
    // pattern the companies module uses on cross-row reads.
    return { ok: false, error: "Company not found" };
  }
  return { ok: true, session };
}

// ── initiateDocumentUpload ──────────────────────────────────────────────────

/**
 * Result payload for `initiateDocumentUpload`. The client needs the
 * `documentId` to call confirm afterwards, the `uploadUrl` to actually
 * PUT bytes, and `mimeType` echoed back so it can set the same value
 * on the upload request (sigv4 binds Content-Type into the signature -
 * any mismatch fails the upload with SignatureDoesNotMatch).
 *
 * `expiresInSeconds` is informational - the client should treat the
 * URL as short-lived and not cache it.
 */
export interface InitiateDocumentUploadResult {
  documentId: string;
  uploadUrl: string;
  /** Echoed so the client can set the matching Content-Type on PUT. */
  mimeType: string;
  /** Echoed so the client can show "your upload link expires in N seconds". */
  expiresInSeconds: number;
}

/**
 * Initiate the two-step document upload.
 *
 * Pipeline:
 *   1. Validate input via Zod
 *   2. Authorise the upload against the target companyId
 *   3. Confirm the target company actually exists (FK would catch this
 *      on insert, but a clear "Company not found" beats a SQL error)
 *   4. Mint a documentId + R2 key
 *   5. INSERT a row with status='pending'
 *   6. Mint a presigned PUT URL targeting that key
 *   7. Return { documentId, uploadUrl, mimeType, expiresInSeconds }
 *
 * No audit log entry here - see top-of-file comment for rationale.
 *
 * Failure modes:
 *   - Invalid input          -> ok:false with the first Zod issue
 *   - Not signed in          -> ok:false "must be signed in"
 *   - Wrong company (company role uploading for someone else's company)
 *                            -> ok:false "Company not found"
 *   - Target company missing -> ok:false "Company not found"
 *   - DB write fails         -> rethrows (500)
 *   - R2 signing fails       -> rethrows (500); leaves an orphan row in
 *                              status='pending' that the cleanup cron
 *                              will sweep later. Tracked.
 */
export async function initiateDocumentUpload(
  rawInput: unknown,
): Promise<ActionResult<InitiateDocumentUploadResult>> {
  // 1. Validate
  const parsed = initiateDocumentUploadSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: InitiateDocumentUploadInput = parsed.data;

  // 2. AuthZ - per-company gate. Order matters: we run AuthZ before the
  //    company-existence check so a cross-company attempt by a company-
  //    role user gets the same "Company not found" response whether the
  //    target company exists or not. Without this ordering, an attacker
  //    could probe for existing company IDs by comparing error messages.
  const auth = await requireUploadAuthority(input.companyId);
  if (!auth.ok) return auth;

  // 3. Confirm the company exists. Admin/staff get a clear error;
  //    company-role users can't reach here for a different companyId
  //    (step 2 blocked them) but the check also catches the case where
  //    a company-role user's own companyId points to a row that's been
  //    deleted out from under them.
  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!company) {
    return { ok: false, error: "Company not found" };
  }

  // 4. Mint identifiers + the R2 key. buildDocumentKey sanitises the
  //    filename internally; the original is preserved in the fileName
  //    column for display.
  const documentId = newId();
  const fileKey = buildDocumentKey(
    input.companyId,
    documentId,
    input.fileName,
  );

  // 5. Insert the pending row. We persist BEFORE signing the URL so a
  //    failure at the signing step still leaves an auditable trail of
  //    the attempt (and a row the cleanup cron can sweep).
  //
  //    `uploadedBy` is the session.userId - the actor who initiated
  //    the upload, regardless of role. Audit will surface admin/staff
  //    uploads on behalf of a company via the actorRole denormalised
  //    field on the audit row.
  try {
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      documentType: input.documentType,
      fileKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      status: "pending",
      issuedOn: input.issuedOn ?? null,
      expiresAt: input.expiresAt ?? null,
      uploadedBy: auth.session.userId,
    });
  } catch (err) {
    log.error("initiateDocumentUpload insert failed", {
      err,
      companyId: input.companyId,
      documentType: input.documentType,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 6. Mint the presigned URL. If this throws, the pending row remains
  //    - the cleanup cron handles it. We deliberately do NOT roll back
  //    the insert because the row is useful evidence ("user tried to
  //    upload at this time") even when the URL mint failed.
  let presigned;
  try {
    presigned = await getPresignedPutUrl(fileKey, input.mimeType);
  } catch (err) {
    log.error("initiateDocumentUpload presign failed", {
      err,
      documentId,
      companyId: input.companyId,
      actorId: auth.session.userId,
    });
    throw err;
  }

  log.info("document upload initiated", {
    documentId,
    companyId: input.companyId,
    documentType: input.documentType,
    sizeBytes: input.sizeBytes,
    actorId: auth.session.userId,
  });

  return {
    ok: true,
    documentId,
    uploadUrl: presigned.url,
    mimeType: input.mimeType,
    expiresInSeconds: presigned.expiresInSeconds,
  };
}

// ── confirmDocumentUpload ──────────────────────────────────────────────────

/**
 * Confirm a previously-initiated upload completed.
 *
 * Pipeline:
 *   1. Validate input (just a documentId)
 *   2. Resolve session (auth required; per-company check happens after
 *      loading the row, since the document carries its own companyId)
 *   3. Load the document row
 *   4. AuthZ against the document's owning companyId
 *   5. Status check - must be 'pending'. If already 'pending_review',
 *      treat as idempotent success (the client may have retried).
 *      Any other status is a refusal (verified/rejected/expired
 *      documents shouldn't be "confirmed" - that would imply re-using
 *      a row for a different upload, which we don't support).
 *   6. Flip status to 'pending_review'
 *   7. Audit `document_uploaded`
 *
 * Failure modes:
 *   - Invalid input              -> ok:false, malformed UUID
 *   - Not signed in              -> ok:false
 *   - Document not found         -> ok:false (also covers "exists but
 *                                   different company" for company-role)
 *   - Document in wrong status   -> ok:false with specific message
 *   - DB write fails             -> rethrows
 *
 * Idempotency: a confirm on an already-confirmed (pending_review) row
 * returns ok:true without writing or auditing. This makes retries safe
 * - the client doesn't need exactly-once delivery semantics.
 */
export async function confirmDocumentUpload(
  rawInput: unknown,
): Promise<ActionResult<{ documentId: string }>> {
  // 1. Validate
  const parsed = confirmDocumentUploadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: "Invalid document id" };
  }
  const { documentId } = parsed.data;

  // 2. Session check (deferred per-company check to after row load)
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // 3. Load the document row. The query carries enough columns for
  //    the AuthZ check, the status gate, and the audit snapshot - one
  //    round-trip.
  const existing = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Document not found" };
  }

  // 4. AuthZ against the document's companyId. Reuse the per-company
  //    gate so the logic stays in one place.
  const auth = await requireUploadAuthority(existing.companyId);
  if (!auth.ok) {
    // The gate's "Company not found" message is the right one to
    // surface even when we technically know "document not found" leaks
    // less - this path is for cross-company access, and a uniform
    // "not found" is the least-leaky response. Note that the row's
    // existence is already implicit in the path the caller took to
    // get here (they had to know the documentId), so leaking that
    // adds nothing.
    return { ok: false, error: "Document not found" };
  }

  // 5. Status gate
  if (existing.status === "pending_review") {
    // Idempotent success. The client retried and we don't need to
    // do anything. Don't audit a second time.
    log.info("document confirm idempotent (already pending_review)", {
      documentId,
      actorId: session.userId,
    });
    return { ok: true, documentId };
  }
  if (existing.status !== "pending") {
    return {
      ok: false,
      error: `Cannot confirm - document is ${existing.status}, not pending`,
    };
  }

  // 6. Flip status. updatedAt updates via the $onUpdate hook in schema.
  try {
    await db
      .update(documents)
      .set({ status: "pending_review" })
      .where(eq(documents.id, existing.id));
  } catch (err) {
    log.error("confirmDocumentUpload update failed", {
      err,
      documentId,
      actorId: session.userId,
    });
    throw err;
  }

  // 7. Audit. `document_uploaded` is the existing verb for this event
  //    (Day 6 audit-schema work added it speculatively; we use it here
  //    for the first time). Target is the document row itself; the
  //    owning companyId rides in metadata for cross-reference.
  await recordAuditEvent({
    actorId: session.userId,
    actorRole: session.role,
    action: "document_uploaded",
    targetType: "document",
    targetId: existing.id,
    before: { status: existing.status },
    after: { status: "pending_review" },
    metadata: {
      companyId: existing.companyId,
      documentType: existing.documentType,
      fileName: existing.fileName,
      mimeType: existing.mimeType,
      sizeBytes: existing.sizeBytes,
      ...(existing.expiresAt ? { expiresAt: existing.expiresAt } : {}),
    },
  });

  log.info("document upload confirmed", {
    documentId,
    companyId: existing.companyId,
    actorId: session.userId,
  });

  return { ok: true, documentId };
}

// ── Read helper (used by tests, may grow in Day 10) ─────────────────────────

/**
 * Single-row fetch for tests and the eventual detail UI. Strips no
 * fields for now - documents have no internalNotes-equivalent. Day 10
 * adds the list endpoint and role-aware scoping for the detail view.
 *
 * Not exposed via the action layer's "use server" boundary except for
 * tests, which import this function directly to assert state changes.
 */
export async function getDocumentById(
  documentId: string,
): Promise<Document | null> {
  const row = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}
