/**
 * Unit tests for `lib/csv.ts` — the shared CSV primitives consumed by
 * every per-domain `*ToCsv` exporter.
 *
 * Covers:
 *   - `csvCell` happy path (no escape needed)
 *   - `csvCell` escapes embedded commas + double quotes + CR + LF
 *   - `csvCell` returns empty string on null / undefined / empty input
 *   - `serialiseCsvRows` composes header + rows with BOM + CRLF
 *   - `serialiseCsvRows` handles an empty data-rows list (header-only)
 *   - `csvFilenameDateStamp` returns YYYY-MM-DD for a given date
 *
 * @module lib/__tests__/csv
 */
import { describe, it, expect } from "vitest";
import {
  csvCell,
  serialiseCsvRows,
  csvFilenameDateStamp,
  CSV_BOM,
  CSV_LINE_ENDING,
} from "../csv";

describe("csvCell", () => {
  it("emits the value verbatim when no escape is needed", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell("2026-05-23")).toBe("2026-05-23");
    expect(csvCell("12345")).toBe("12345");
  });

  it("wraps a value containing a comma in double quotes", () => {
    expect(csvCell("Co, Inc.")).toBe('"Co, Inc."');
  });

  it("wraps and doubles an embedded double quote", () => {
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
  });

  it("wraps a value containing CR or LF", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("returns empty string on null, undefined, or empty input", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("")).toBe("");
  });
});

describe("serialiseCsvRows", () => {
  it("composes header + rows with BOM + CRLF line endings", () => {
    const csv = serialiseCsvRows(
      ["A", "B", "C"],
      [
        ["1", "2", "3"],
        ["4", "5", "6"],
      ],
    );

    // BOM prefix.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith(CSV_BOM)).toBe(true);

    // Header + two data rows joined by CRLF.
    const body = csv.slice(CSV_BOM.length);
    expect(body).toBe(
      `A,B,C${CSV_LINE_ENDING}1,2,3${CSV_LINE_ENDING}4,5,6`,
    );
  });

  it("escapes each cell through csvCell", () => {
    const csv = serialiseCsvRows(
      ["Name", "Note"],
      [["Co, Inc.", 'He said "yes"']],
    );

    expect(csv).toContain('"Co, Inc.","He said ""yes"""');
  });

  it("renders a header-only CSV when given an empty data-rows list", () => {
    const csv = serialiseCsvRows(["A", "B"], []);
    expect(csv).toBe(`${CSV_BOM}A,B`);
  });

  it("renders empty cells for null / undefined entries in a data row", () => {
    const csv = serialiseCsvRows(
      ["A", "B", "C"],
      [["x", null, undefined]],
    );
    expect(csv).toContain("x,,");
  });
});

describe("csvFilenameDateStamp", () => {
  it("returns YYYY-MM-DD for a given date", () => {
    const d = new Date("2026-05-23T15:42:00Z");
    expect(csvFilenameDateStamp(d)).toBe("2026-05-23");
  });

  it("defaults to today when no argument is passed", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(csvFilenameDateStamp()).toBe(today);
  });
});
