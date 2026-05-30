/**
 * Tests for the placeholder-PDF generator. The one silently-breakable
 * piece is the cross-reference offset math, so the main test parses the
 * emitted xref table and asserts every offset lands exactly on its
 * `N 0 obj` header. `main()` is guarded by `!process.env.VITEST`, so
 * importing the module here writes no file.
 *
 * @module scripts/__tests__/make-placeholder-pdf
 */
import { describe, it, expect } from "vitest";
import { buildPlaceholderPdf } from "../make-placeholder-pdf";

describe("buildPlaceholderPdf", () => {
  it("produces a structurally valid PDF with well-formed xref offsets", () => {
    const s = buildPlaceholderPdf("hello staging").toString("latin1");

    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);

    const xrefIdx = s.indexOf("\nxref\n");
    expect(xrefIdx).toBeGreaterThan(0);

    // After "\nxref\n": "0 6", the free entry, then 5 in-use entries.
    const lines = s.slice(xrefIdx + 6).split("\n");
    const entries = lines.slice(2).filter((l) => / 00000 n /.test(l));
    expect(entries).toHaveLength(5);

    entries.forEach((line, i) => {
      const offset = Number.parseInt(line.slice(0, 10), 10);
      expect(s.startsWith(`${i + 1} 0 obj`, offset)).toBe(true);
    });
  });

  it("declares a /Length matching the actual content-stream bytes", () => {
    const s = buildPlaceholderPdf("abc").toString("latin1");
    const declared = Number.parseInt(/\/Length (\d+)/.exec(s)![1], 10);
    const stream = /stream\n([\s\S]*?)\nendstream/.exec(s)![1];
    expect(stream.length).toBe(declared);
  });

  it("strips PDF-unsafe and non-ASCII characters from the text", () => {
    // parens, backslash, and the ₹ sign are removed; the rest survives.
    const s = buildPlaceholderPdf("a(b)c\\d₹e").toString("latin1");
    expect(s).toContain("(abcde) Tj");
  });
});
