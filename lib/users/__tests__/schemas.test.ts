/**
 * Unit tests for the users-module Zod schemas.
 *
 * Pure validation — no DB, no session. Covers the role ↔ company invariant
 * (the only non-trivial logic), email normalisation, and the list-query
 * coercion + defaults.
 *
 * @module lib/users/__tests__/schemas
 */
import { describe, it, expect } from "vitest";
import { newId } from "@/lib/db/ids";
import {
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
  userIdSchema,
} from "../schemas";

// Real UUID v7 — zod 4's `.uuid()` validates the version/variant nibbles,
// so a hand-written all-zeros string would (correctly) be rejected.
const UUID = newId();

describe("createUserSchema", () => {
  it("accepts an admin with no company", () => {
    const r = createUserSchema.safeParse({
      email: "Admin@Test.LOCAL",
      name: "Ada Admin",
      role: "admin",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("admin@test.local"); // lowercased
  });

  it("rejects an admin that carries a companyId", () => {
    const r = createUserSchema.safeParse({
      email: "admin@test.local",
      name: "Ada Admin",
      role: "admin",
      companyId: UUID,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["companyId"]);
  });

  it("rejects a company-role user with no companyId", () => {
    const r = createUserSchema.safeParse({
      email: "c@test.local",
      name: "Cara Company",
      role: "company",
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["companyId"]);
  });

  it("accepts a company-role user with a companyId", () => {
    const r = createUserSchema.safeParse({
      email: "c@test.local",
      name: "Cara Company",
      role: "company",
      companyId: UUID,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid email and a too-short name", () => {
    expect(
      createUserSchema.safeParse({ email: "nope", name: "Ok", role: "staff" })
        .success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({ email: "a@b.co", name: "x", role: "staff" })
        .success,
    ).toBe(false);
  });
});

describe("updateUserSchema", () => {
  it("requires an id", () => {
    expect(updateUserSchema.safeParse({ name: "New Name" }).success).toBe(false);
  });

  it("accepts a partial patch (name only)", () => {
    const r = updateUserSchema.safeParse({ id: UUID, name: "New Name" });
    expect(r.success).toBe(true);
  });

  it("enforces the invariant only when both role and companyId are present", () => {
    // company + no company id (explicit null) → fail
    const bad = updateUserSchema.safeParse({
      id: UUID,
      role: "company",
      companyId: null,
    });
    expect(bad.success).toBe(false);

    // staff + a company id → fail
    const bad2 = updateUserSchema.safeParse({
      id: UUID,
      role: "staff",
      companyId: UUID,
    });
    expect(bad2.success).toBe(false);

    // role-only change (no companyId in patch) → schema allows; the action
    // re-checks against merged state.
    expect(
      updateUserSchema.safeParse({ id: UUID, role: "staff" }).success,
    ).toBe(true);
  });
});

describe("listUsersQuerySchema", () => {
  it("applies pagination + sort defaults on empty input", () => {
    const r = listUsersQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.perPage).toBe(20);
    expect(r.sortBy).toBe("createdAt");
    expect(r.sortDir).toBe("desc");
  });

  it("coerces page/perPage from strings and caps perPage at 100", () => {
    const r = listUsersQuerySchema.parse({ page: "3", perPage: "20" });
    expect(r.page).toBe(3);
    expect(r.perPage).toBe(20);
    expect(listUsersQuerySchema.safeParse({ perPage: "500" }).success).toBe(
      false,
    );
  });

  it("accepts role + status + search filters", () => {
    const r = listUsersQuerySchema.parse({
      role: "staff",
      status: "inactive",
      search: "ada",
    });
    expect(r.role).toBe("staff");
    expect(r.status).toBe("inactive");
    expect(r.search).toBe("ada");
  });

  it("rejects an unknown sort column and unknown status", () => {
    expect(listUsersQuerySchema.safeParse({ sortBy: "ssn" }).success).toBe(
      false,
    );
    expect(listUsersQuerySchema.safeParse({ status: "banned" }).success).toBe(
      false,
    );
  });
});

describe("userIdSchema", () => {
  it("accepts a uuid, rejects garbage", () => {
    expect(userIdSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(userIdSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });
});
