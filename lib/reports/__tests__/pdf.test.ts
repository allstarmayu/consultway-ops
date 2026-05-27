/**
 * Unit tests for `renderReportPdf` (`lib/reports/pdf.tsx`).
 *
 * The renderer is intentionally pure — no DB calls, no session reads —
 * so the tests build synthetic payloads against the public input shape
 * and assert on the rendered byte buffer's surface properties:
 *
 *   - Returns a non-empty `Uint8Array`.
 *   - Starts with the `%PDF-` magic header (so we know it's a valid PDF
 *     envelope, not some text rendering of the payload).
 *   - Renders cleanly across the three representative payloads:
 *       admin (with transactions) / staff (no transactions) / empty
 *       (zero rows across all three sections).
 *
 * We don't pin exact byte length — `@react-pdf/renderer` can change its
 * compression behaviour between minor versions and the test should stay
 * stable across non-breaking upgrades.
 *
 * @module lib/reports/__tests__/pdf
 */
import { describe, it, expect } from "vitest";
import { renderReportPdf, type ReportPdfInput } from "../pdf";

// Skipped while `lib/reports/pdf.tsx` is stubbed for the Cloudflare
// Worker deploy (see module docstring there). The renderer's real
// implementation lives in git history at commit 679a642; un-stub it
// + flip this back to `describe(...)` when the dedicated PDF worker
// ships.
const describeWhenRendererAvailable = describe.skip;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Fixed timestamp so the cover renders deterministically. */
const FIXED_GENERATED_AT = new Date("2026-05-23T10:00:00Z");

/** PDF magic header — every spec-compliant PDF starts with these bytes. */
const PDF_MAGIC = "%PDF-";

function pdfHeader(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.slice(0, 5));
}

function adminPayload(
  overrides: Partial<ReportPdfInput> = {},
): ReportPdfInput {
  return {
    start: "2026-05-01",
    end: "2026-05-31",
    role: "admin",
    companyName: "Acme Construction",
    generatedAt: FIXED_GENERATED_AT,
    projects: {
      byStatus: {
        planning: 2,
        active: 3,
        on_hold: 0,
        completed: 1,
        cancelled: 0,
      },
    },
    tenders: {
      byStatus: {
        draft: 0,
        published: 4,
        closed: 1,
        awarded: 1,
      },
    },
    transactions: {
      countByType: {
        invoice: 5,
        payment: 3,
        expense: 2,
        advance: 1,
        refund: 0,
      },
      totalPaiseByType: {
        invoice: 100_000_00,
        payment: 50_000_00,
        expense: 12_500_00,
        advance: 25_000_00,
        refund: 0,
      },
      totalPaise: 187_500_00,
      totalCount: 11,
    },
    ...overrides,
  };
}

function staffPayload(): ReportPdfInput {
  return {
    start: "2026-05-01",
    end: "2026-05-31",
    role: "staff",
    generatedAt: FIXED_GENERATED_AT,
    projects: {
      byStatus: {
        planning: 1,
        active: 2,
        on_hold: 0,
        completed: 0,
        cancelled: 0,
      },
    },
    tenders: {
      byStatus: {
        draft: 0,
        published: 1,
        closed: 0,
        awarded: 0,
      },
    },
    // No transactions section — staff cannot see this surface.
  };
}

function emptyPayload(): ReportPdfInput {
  return {
    start: "2026-05-01",
    end: "2026-05-31",
    role: "admin",
    generatedAt: FIXED_GENERATED_AT,
    projects: {
      byStatus: {
        planning: 0,
        active: 0,
        on_hold: 0,
        completed: 0,
        cancelled: 0,
      },
    },
    tenders: {
      byStatus: {
        draft: 0,
        published: 0,
        closed: 0,
        awarded: 0,
      },
    },
    transactions: {
      countByType: {
        invoice: 0,
        payment: 0,
        expense: 0,
        advance: 0,
        refund: 0,
      },
      totalPaiseByType: {
        invoice: 0,
        payment: 0,
        expense: 0,
        advance: 0,
        refund: 0,
      },
      totalPaise: 0,
      totalCount: 0,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describeWhenRendererAvailable("renderReportPdf", () => {
  it("returns a non-empty Uint8Array for an admin payload", async () => {
    const bytes = await renderReportPdf(adminPayload());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("renders bytes starting with the %PDF- magic header", async () => {
    const bytes = await renderReportPdf(adminPayload());
    expect(pdfHeader(bytes)).toBe(PDF_MAGIC);
  });

  it("renders cleanly for a staff payload (no transactions section)", async () => {
    const bytes = await renderReportPdf(staffPayload());
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(pdfHeader(bytes)).toBe(PDF_MAGIC);
  });

  it("renders cleanly for an empty-period payload (all zeros)", async () => {
    const bytes = await renderReportPdf(emptyPayload());
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(pdfHeader(bytes)).toBe(PDF_MAGIC);
  });

  it("renders cleanly when companyName is omitted (all-companies scope)", async () => {
    const bytes = await renderReportPdf(
      adminPayload({ companyName: undefined }),
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(pdfHeader(bytes)).toBe(PDF_MAGIC);
  });
});
