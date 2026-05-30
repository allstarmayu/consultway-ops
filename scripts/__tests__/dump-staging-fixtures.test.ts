/**
 * Unit tests for the SQL-emit core of `scripts/dump-staging-fixtures.ts`.
 *
 * The script itself is a thin better-sqlite3 reader; the only non-trivial
 * logic is value escaping + statement assembly, which is what these tests
 * pin (per docs/12-testing.md — test the logic, skip the I/O shell).
 * `main()` is guarded by `!process.env.VITEST`, so importing the module
 * here does not open a database.
 *
 * @module scripts/__tests__/dump-staging-fixtures
 */
import { describe, it, expect } from "vitest";
import {
  sqlLiteral,
  quoteIdent,
  buildInsertStatement,
} from "../dump-staging-fixtures";

describe("sqlLiteral", () => {
  it("renders null and undefined as NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
  });

  it("renders integers (incl. zero and negatives) verbatim", () => {
    expect(sqlLiteral(0)).toBe("0");
    expect(sqlLiteral(187_000)).toBe("187000");
    expect(sqlLiteral(-45)).toBe("-45");
  });

  it("renders bigints verbatim (no precision loss on large amounts)", () => {
    // Constructed via BigInt() rather than a 1_000_000_000n literal — the
    // project's tsconfig target is ES2017, which disallows BigInt literals.
    expect(sqlLiteral(BigInt(1_000_000_000))).toBe("1000000000");
  });

  it("renders booleans as 1 / 0", () => {
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
  });

  it("single-quotes strings and doubles embedded apostrophes", () => {
    expect(sqlLiteral("BuildRight")).toBe("'BuildRight'");
    expect(sqlLiteral("one partner's signatory")).toBe(
      "'one partner''s signatory'",
    );
  });

  it("preserves unicode (₹, em-dash) inside string literals", () => {
    expect(sqlLiteral("₹50 lakh — paid")).toBe("'₹50 lakh — paid'");
  });

  it("renders Buffer / Uint8Array as a hex blob literal", () => {
    expect(sqlLiteral(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(
      "X'deadbeef'",
    );
    expect(sqlLiteral(new Uint8Array([0x00, 0x01]))).toBe("X'0001'");
  });

  it("throws on non-finite numbers rather than emitting NaN/Infinity", () => {
    expect(() => sqlLiteral(Number.NaN)).toThrow();
    expect(() => sqlLiteral(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("throws on unsupported types rather than coercing", () => {
    expect(() => sqlLiteral({ a: 1 })).toThrow();
    expect(() => sqlLiteral([1, 2])).toThrow();
  });
});

describe("quoteIdent", () => {
  it("double-quotes identifiers and escapes embedded quotes", () => {
    expect(quoteIdent("company_id")).toBe('"company_id"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("buildInsertStatement", () => {
  it("assembles an idempotent INSERT with quoted identifiers", () => {
    expect(
      buildInsertStatement("companies", ["id", "name", "annual_turnover"], {
        id: "abc",
        name: "Acme",
        annual_turnover: null,
      }),
    ).toBe(
      `INSERT INTO "companies" ("id", "name", "annual_turnover") VALUES ('abc', 'Acme', NULL) ON CONFLICT DO NOTHING;`,
    );
  });

  it("emits values in the given column order", () => {
    expect(buildInsertStatement("t", ["b", "a"], { a: 1, b: 2 })).toBe(
      `INSERT INTO "t" ("b", "a") VALUES (2, 1) ON CONFLICT DO NOTHING;`,
    );
  });
});
