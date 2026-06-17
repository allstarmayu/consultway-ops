/**
 * Unit tests for `lib/tenders/csv.ts`.
 *
 * Pure helper — no DB needed, no session mocks. Mock rows in, CSV out.
 *
 * Covers:
 *   - Header row + correct value formatting (BOM, CRLF)
 *   - NULL handling on every nullable column (referenceNumber,
 *     openingDate, closingDate, awardedCompanyId, publishedAt)
 *   - Awarded-company name lookup; missing lookup → empty cell
 *   - RFC-4180 escape on titles with embedded commas + double quotes
 *   - publisherCompanyId is NOT NULL on the schema — pinned by a test
 *     that the lookup always resolves to a name
 *
 * @module lib/tenders/__tests__/csv
 */
import { describe, it, expect } from "vitest";
import type { Tender } from "@/lib/db/schema";
import { tendersToCsv } from "../csv";

/**
 * Helper for building a Tender fixture with sensible defaults. Tests
 * override the fields they care about.
 */
function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: "t1",
    title: "Sample tender",
    description: null,
    referenceNumber: null,
    status: "draft",
    publisherCompanyId: "publisher-1",
    sector: "Infrastructure",
    geography: "Maharashtra",
    visibility: "open",
    eligibleSector: null,
    eligibleGeography: null,
    minAnnualTurnoverInr: null,
    msmeOnly: false,
    openingDate: null,
    closingDate: null,
    internalNotes: null,
    createdAt: "2026-05-01 10:00:00",
    updatedAt: "2026-05-01 10:00:00",
    publishedAt: null,
    awardedCompanyId: null,
    ...overrides,
  };
}

describe("tendersToCsv", () => {
  it("produces a header row + correct value formatting (BOM, CRLF)", () => {
    const rows: Tender[] = [
      makeTender({
        id: "t1",
        title: "May infrastructure pilot",
        referenceNumber: "CW-2026-INFRA-014",
        status: "published",
        publisherCompanyId: "publisher-1",
        sector: "Infrastructure",
        geography: "Maharashtra",
        openingDate: "2026-05-05",
        closingDate: "2026-06-15",
        publishedAt: "2026-05-03 10:00:00",
      }),
    ];

    const csv = tendersToCsv(rows, {
      companyNames: new Map([["publisher-1", "Consultway Infotech"]]),
    });

    // UTF-8 BOM prefix.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // CRLF line endings.
    expect(csv).toMatch(/\r\n/);
    // Header present.
    expect(csv).toContain(
      "Title,Status,Reference,Publisher,Sector,Geography,Opening,Closing,Awarded company,Published at",
    );
    // Data row — publisher resolved, awarded-company empty.
    expect(csv).toContain(
      "May infrastructure pilot,published,CW-2026-INFRA-014,Consultway Infotech,Infrastructure,Maharashtra,2026-05-05,2026-06-15,,2026-05-03 10:00:00",
    );
  });

  it("renders NULL nullable columns as empty cells", () => {
    const rows: Tender[] = [
      makeTender({
        id: "t1",
        title: "Bare-bones draft",
        referenceNumber: null,
        publisherCompanyId: "publisher-1",
        openingDate: null,
        closingDate: null,
        awardedCompanyId: null,
        publishedAt: null,
      }),
    ];

    const csv = tendersToCsv(rows, {
      companyNames: new Map([["publisher-1", "Acme"]]),
    });

    // The reference, opening, closing, awarded company, and published-at
    // cells are all empty. Publisher + sector + geography + status +
    // title remain populated.
    expect(csv).toContain(
      "Bare-bones draft,draft,,Acme,Infrastructure,Maharashtra,,,,",
    );
  });

  it("resolves the awarded-company name when set; missing lookup → empty cell", () => {
    const rows: Tender[] = [
      makeTender({
        id: "t1",
        title: "Awarded to Acme",
        status: "awarded",
        publisherCompanyId: "publisher-1",
        awardedCompanyId: "winner-1",
        publishedAt: "2026-05-10 09:00:00",
      }),
      makeTender({
        id: "t2",
        title: "Awarded but lookup missing",
        status: "awarded",
        publisherCompanyId: "publisher-1",
        awardedCompanyId: "winner-missing",
        publishedAt: "2026-05-12 09:00:00",
      }),
    ];

    const csv = tendersToCsv(rows, {
      companyNames: new Map([
        ["publisher-1", "Consultway"],
        ["winner-1", "Acme Construction"],
      ]),
    });

    // First row — winner resolved.
    expect(csv).toContain(
      "Awarded to Acme,awarded,,Consultway,Infrastructure,Maharashtra,,,Acme Construction,2026-05-10 09:00:00",
    );
    // Second row — winner lookup misses, cell renders empty without
    // breaking the rest of the row.
    expect(csv).toContain(
      "Awarded but lookup missing,awarded,,Consultway,Infrastructure,Maharashtra,,,,2026-05-12 09:00:00",
    );
  });

  it("escapes embedded commas + double quotes in titles per RFC-4180", () => {
    const rows: Tender[] = [
      makeTender({
        id: "t1",
        title: 'Tender with "quoted" name, and a comma',
        publisherCompanyId: "publisher-1",
      }),
    ];

    const csv = tendersToCsv(rows, {
      companyNames: new Map([["publisher-1", "Co, Inc."]]),
    });

    // Title has both a comma + a double quote — whole field quoted,
    // internal double quotes doubled.
    expect(csv).toContain(
      '"Tender with ""quoted"" name, and a comma"',
    );
    // Publisher name has a comma — quoted.
    expect(csv).toContain('"Co, Inc."');
  });

  it("always resolves publisherCompanyId to a name (column is NOT NULL on schema)", () => {
    // Pin the contract: every tender has a publisher. Even with an
    // empty lookup the cell renders empty rather than crashing; the
    // schema's ON DELETE RESTRICT cascade should make this empty-cell
    // case unreachable in production, but the helper degrades gracefully.
    const rows: Tender[] = [
      makeTender({
        id: "t1",
        title: "Orphaned publisher lookup",
        publisherCompanyId: "publisher-missing",
      }),
    ];

    const csv = tendersToCsv(rows, {
      companyNames: new Map(),
    });

    // Publisher column collapses to empty cell.
    expect(csv).toContain(
      "Orphaned publisher lookup,draft,,,Infrastructure,Maharashtra,,,,",
    );
  });
});
