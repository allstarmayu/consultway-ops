/**
 * Unit tests for `lib/projects/csv.ts`.
 *
 * Pure helper — no DB needed, no session mocks. Just feed in mock rows
 * and assert the CSV shape:
 *
 *   - Header row + standard cell formatting (BOM, CRLF)
 *   - RFC-4180 escape on embedded commas + double quotes
 *   - NULL handling on every nullable column (tenderId, startDate,
 *     endDate, budgetInr)
 *   - Budget formatted as a whole-rupees integer (NO paise tail —
 *     projects use the rupees-only regime, distinct from transactions'
 *     paise-precision regime)
 *   - `projectsCsvFilenameDateStamp` returns YYYY-MM-DD
 *
 * @module lib/projects/__tests__/csv
 */
import { describe, it, expect } from "vitest";
import type { Project } from "@/lib/db/schema";
import {
  projectsToCsv,
  projectsCsvFilenameDateStamp,
} from "../csv";

/**
 * Helper for building a Project fixture with sensible defaults. Tests
 * override the fields they care about.
 */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Sample project",
    description: null,
    tenderId: null,
    companyId: "c1",
    status: "planning",
    startDate: null,
    endDate: null,
    budgetInr: null,
    internalNotes: null,
    createdAt: "2026-05-01 10:00:00",
    updatedAt: "2026-05-01 10:00:00",
    ...overrides,
  };
}

describe("projectsToCsv", () => {
  it("produces a header row + correct value formatting (BOM, CRLF)", () => {
    const rows: Project[] = [
      makeProject({
        id: "p1",
        name: "Acme infrastructure pilot",
        status: "active",
        companyId: "c1",
        startDate: "2026-05-01",
        endDate: "2026-12-31",
        budgetInr: 5_00_00_000, // ₹5 crore
        createdAt: "2026-05-01 10:00:00",
      }),
    ];

    const csv = projectsToCsv(rows, {
      companyNames: new Map([["c1", "Acme Construction"]]),
    });

    // UTF-8 BOM prefix.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // CRLF line endings.
    expect(csv).toMatch(/\r\n/);
    // Header present.
    expect(csv).toContain(
      "Name,Status,Company,Start,End,Budget,Tender,Created at",
    );
    // Data row — budget is plain integer rupees (no paise tail).
    expect(csv).toContain(
      "Acme infrastructure pilot,active,Acme Construction,2026-05-01,2026-12-31,50000000,",
    );
  });

  it("escapes embedded commas + double quotes per RFC-4180", () => {
    const rows: Project[] = [
      makeProject({
        id: "p1",
        name: 'Project with "quoted" name and, comma',
        companyId: "c1",
        budgetInr: null,
      }),
    ];

    const csv = projectsToCsv(rows, {
      companyNames: new Map([["c1", "Co, Inc."]]),
    });

    // Company name has a comma — quoted.
    expect(csv).toContain('"Co, Inc."');
    // Name has both a comma + an embedded double quote — whole field
    // quoted, internal double quotes doubled.
    expect(csv).toContain(
      '"Project with ""quoted"" name and, comma"',
    );
  });

  it("renders NULL nullable columns as empty cells", () => {
    const rows: Project[] = [
      makeProject({
        id: "p1",
        name: "Bare-bones project",
        status: "planning",
        companyId: "c1",
        tenderId: null,
        startDate: null,
        endDate: null,
        budgetInr: null,
        createdAt: "2026-05-01 10:00:00",
      }),
    ];

    const csv = projectsToCsv(rows, {
      companyNames: new Map([["c1", "Acme"]]),
    });

    // Five empty trailing cells before the createdAt: start, end,
    // budget, tender — then the createdAt.
    expect(csv).toContain(
      "Bare-bones project,planning,Acme,,,,,2026-05-01 10:00:00",
    );
  });

  it("formats budgetInr as plain rupees (no thousands separators, no paise)", () => {
    const rows: Project[] = [
      makeProject({
        id: "p1",
        name: "Small project",
        budgetInr: 12345,
        companyId: "c1",
      }),
      makeProject({
        id: "p2",
        name: "Crore project",
        budgetInr: 1_00_00_000,
        companyId: "c1",
      }),
    ];

    const csv = projectsToCsv(rows, {
      companyNames: new Map([["c1", "Acme"]]),
    });

    // Plain integer — no decimal tail, no commas, no glyph.
    expect(csv).toContain(",12345,");
    expect(csv).toContain(",10000000,");
    expect(csv).not.toContain("₹");
    expect(csv).not.toContain(".00");
  });

  it("truncates the tenderId to a short reference form", () => {
    const tenderUuid = "01234567-89ab-cdef-0123-456789abcdef";
    const rows: Project[] = [
      makeProject({
        id: "p1",
        name: "From tender",
        tenderId: tenderUuid,
        companyId: "c1",
      }),
    ];

    const csv = projectsToCsv(rows, {
      companyNames: new Map([["c1", "Acme"]]),
    });

    // First 8 chars + ellipsis. The full uuid should NOT appear.
    expect(csv).toContain("01234567...");
    expect(csv).not.toContain(tenderUuid);
  });

  it("uses an empty Company cell when the lookup misses the row's companyId", () => {
    const rows: Project[] = [
      makeProject({
        id: "p1",
        name: "Orphaned lookup",
        companyId: "missing-id",
      }),
    ];

    const csv = projectsToCsv(rows, {
      companyNames: new Map(),
    });

    // Company column collapses to an empty cell; the rest of the row
    // is still well-formed.
    expect(csv).toContain("Orphaned lookup,planning,,");
  });
});

describe("projectsCsvFilenameDateStamp", () => {
  it("returns YYYY-MM-DD for a given date", () => {
    const d = new Date("2026-05-23T15:42:00Z");
    expect(projectsCsvFilenameDateStamp(d)).toBe("2026-05-23");
  });

  it("defaults to today when no argument is passed", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(projectsCsvFilenameDateStamp()).toBe(today);
  });
});
