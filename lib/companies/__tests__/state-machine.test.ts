/**
 * Unit tests for `lib/companies/state-machine.ts`.
 *
 * Pure tests — no DB, no fixtures. Pins the legal-transitions table
 * cell-by-cell so a future edit to the table can't silently drop a
 * legal transition or open up an illegal one without a failing test.
 *
 * Coverage:
 *   - Every legal transition passes `canTransitionCompliance`.
 *   - Every illegal transition fails `canTransitionCompliance`.
 *   - `assertTransitionCompliance` throws `ComplianceTransitionError`
 *     for illegal pairs and doesn't throw for legal pairs.
 *   - `rejected` is terminal (every outbound pair throws).
 *   - `suspended ↔ compliant` is reversible per the Day 22 spec.
 *   - `from === to` is a no-op (does not throw).
 *
 * @module lib/companies/__tests__/state-machine
 */
import { describe, it, expect } from "vitest";
import type { ComplianceStatus } from "@/lib/db/schema";
import {
  COMPLIANCE_STATUS_TRANSITIONS,
  ComplianceTransitionError,
  assertTransitionCompliance,
  canTransitionCompliance,
} from "../state-machine";

const ALL_STATUSES: readonly ComplianceStatus[] = [
  "pending",
  "compliant",
  "non_compliant",
  "expired",
  "suspended",
  "rejected",
] as const;

// ── Legal transitions, per the Day 23 table ──────────────────────────────

const LEGAL_PAIRS: ReadonlyArray<[ComplianceStatus, ComplianceStatus]> = [
  // pending row
  ["pending", "compliant"],
  ["pending", "non_compliant"],
  ["pending", "rejected"],
  // compliant row
  ["compliant", "non_compliant"],
  ["compliant", "expired"],
  ["compliant", "suspended"],
  // non_compliant row
  ["non_compliant", "compliant"],
  ["non_compliant", "suspended"],
  // expired row
  ["expired", "compliant"],
  ["expired", "non_compliant"],
  ["expired", "suspended"],
  // suspended row
  ["suspended", "compliant"],
  ["suspended", "non_compliant"],
];

const LEGAL_PAIR_KEYS = new Set(LEGAL_PAIRS.map(([f, t]) => `${f}->${t}`));

function isExpectedLegal(from: ComplianceStatus, to: ComplianceStatus): boolean {
  if (from === to) return true; // same-state is a no-op, treated as legal
  return LEGAL_PAIR_KEYS.has(`${from}->${to}`);
}

// ── canTransitionCompliance ──────────────────────────────────────────────

describe("canTransitionCompliance — legal pairs", () => {
  for (const [from, to] of LEGAL_PAIRS) {
    it(`${from} → ${to} is legal`, () => {
      expect(canTransitionCompliance(from, to)).toBe(true);
    });
  }
});

describe("canTransitionCompliance — full matrix", () => {
  // Cross-product. Catches accidental ✓ openings AND accidental — closures.
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const expected = isExpectedLegal(from, to);
      it(`${from} → ${to} ${expected ? "legal" : "illegal"}`, () => {
        expect(canTransitionCompliance(from, to)).toBe(expected);
      });
    }
  }
});

// ── assertTransitionCompliance ───────────────────────────────────────────

describe("assertTransitionCompliance — legal pairs do not throw", () => {
  for (const [from, to] of LEGAL_PAIRS) {
    it(`${from} → ${to} does not throw`, () => {
      expect(() => assertTransitionCompliance(from, to)).not.toThrow();
    });
  }
});

describe("assertTransitionCompliance — illegal pairs throw", () => {
  // Batched by `from` state for readability.
  const byFrom = new Map<ComplianceStatus, ComplianceStatus[]>();
  for (const from of ALL_STATUSES) {
    const illegalTos = ALL_STATUSES.filter((to) => !isExpectedLegal(from, to));
    byFrom.set(from, illegalTos);
  }

  for (const [from, illegalTos] of byFrom) {
    if (illegalTos.length === 0) continue; // every-target-legal row (none today)

    it(`from "${from}", illegal targets [${illegalTos.join(", ")}] each throw`, () => {
      for (const to of illegalTos) {
        expect(() => assertTransitionCompliance(from, to)).toThrow(
          ComplianceTransitionError,
        );
      }
    });
  }

  it("thrown error carries both `from` and `to` for log clarity", () => {
    try {
      assertTransitionCompliance("compliant", "pending");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceTransitionError);
      const tErr = err as ComplianceTransitionError;
      expect(tErr.from).toBe("compliant");
      expect(tErr.to).toBe("pending");
      expect(tErr.message).toContain("compliant");
      expect(tErr.message).toContain("pending");
    }
  });
});

// ── Terminal-state pin ───────────────────────────────────────────────────

describe("rejected is terminal", () => {
  it("rejected has zero legal outbound transitions in the table", () => {
    expect(COMPLIANCE_STATUS_TRANSITIONS.rejected.size).toBe(0);
  });

  for (const to of ALL_STATUSES) {
    if (to === "rejected") continue; // same-state no-op covered separately
    it(`rejected → ${to} throws`, () => {
      expect(() => assertTransitionCompliance("rejected", to)).toThrow(
        ComplianceTransitionError,
      );
    });
  }
});

// ── Reversibility pin (Day 22 spec) ──────────────────────────────────────

describe("suspended ↔ compliant reversibility", () => {
  it("compliant → suspended is legal", () => {
    expect(canTransitionCompliance("compliant", "suspended")).toBe(true);
  });
  it("suspended → compliant is legal", () => {
    expect(canTransitionCompliance("suspended", "compliant")).toBe(true);
  });
});

// ── Same-state no-op ─────────────────────────────────────────────────────

describe("same-state transitions are no-ops (do not throw)", () => {
  for (const s of ALL_STATUSES) {
    it(`${s} → ${s} does not throw`, () => {
      expect(() => assertTransitionCompliance(s, s)).not.toThrow();
      expect(canTransitionCompliance(s, s)).toBe(true);
    });
  }
});
