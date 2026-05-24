/**
 * Unit tests for `stripAdminOnlyFields` from `lib/companies/actions.ts`.
 *
 * Pure — no DB, no fixtures. Pins the field-strip contract used by
 * `getCompany` and `listCompanies` to keep admin-only columns out of
 * any payload handed to a `company`-role caller.
 *
 * Day 23 added `rejectionReason` to the strip alongside `internalNotes`.
 * The callout on the company detail page surfaces the reason for
 * admin/staff only; the strip keeps the field from leaking through any
 * other read surface.
 *
 * @module lib/companies/__tests__/field-strip
 */
import { describe, it, expect } from "vitest";
import type { Company, UserRole } from "@/lib/db/schema";
import { stripAdminOnlyFields } from "../field-strip";

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Test Co",
    sector: "Infrastructure",
    geography: "Maharashtra",
    gstNumber: null,
    panNumber: null,
    isMsme: false,
    isJv: false,
    complianceStatus: "rejected",
    parentCompanyIds: null,
    annualTurnover: null,
    contactEmail: null,
    contactPhone: null,
    contactPersonName: null,
    addressLine: null,
    city: null,
    state: null,
    pincode: null,
    internalNotes: "Background check raised flags on directors A and B.",
    rejectionReason: "Failed background check on directors at intake.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("stripAdminOnlyFields — company-role caller", () => {
  it("nulls internalNotes AND rejectionReason", () => {
    const row = makeCompany();
    const stripped = stripAdminOnlyFields(row, "company" satisfies UserRole);
    expect(stripped.internalNotes).toBeNull();
    expect(stripped.rejectionReason).toBeNull();
  });

  it("leaves the rest of the row intact (identity check)", () => {
    const row = makeCompany();
    const stripped = stripAdminOnlyFields(row, "company");
    // Spot-check a representative subset.
    expect(stripped.id).toBe(row.id);
    expect(stripped.name).toBe(row.name);
    expect(stripped.complianceStatus).toBe(row.complianceStatus);
    expect(stripped.sector).toBe(row.sector);
    expect(stripped.geography).toBe(row.geography);
  });

  it("does not mutate the input row", () => {
    const row = makeCompany();
    const before = row.rejectionReason;
    stripAdminOnlyFields(row, "company");
    expect(row.rejectionReason).toBe(before);
    expect(row.internalNotes).not.toBeNull();
  });
});

describe("stripAdminOnlyFields — admin / staff caller", () => {
  it("passes rejectionReason through for admin", () => {
    const row = makeCompany();
    const result = stripAdminOnlyFields(row, "admin");
    expect(result.rejectionReason).toBe(row.rejectionReason);
    expect(result.internalNotes).toBe(row.internalNotes);
  });

  it("passes rejectionReason through for staff", () => {
    const row = makeCompany();
    const result = stripAdminOnlyFields(row, "staff");
    expect(result.rejectionReason).toBe(row.rejectionReason);
    expect(result.internalNotes).toBe(row.internalNotes);
  });
});
