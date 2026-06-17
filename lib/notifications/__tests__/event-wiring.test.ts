/**
 * Event-wiring tests — proves a domain action actually raises an in-app
 * notification at its event site. Uses the company compliance transition as
 * the representative case (the tender application-decision wiring is the same
 * `createNotificationsForUsers` shape, exercised by the tenders suite).
 *
 * @module lib/notifications/__tests__/event-wiring
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, users, notifications } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));

import { readSession } from "@/lib/auth/session";
import { transitionComplianceStatus } from "@/lib/companies/actions";

const mockedReadSession = vi.mocked(readSession);
const ADMIN_ID = newId();

beforeEach(async () => {
  await db.delete(notifications);
  await db.delete(users);
  await db.delete(companies);
  mockedReadSession.mockResolvedValue({
    userId: ADMIN_ID,
    email: "admin@test.local",
    role: "admin",
    companyId: null,
  });
});

async function seedActiveCompanyWithUser() {
  const companyId = newId();
  const userId = newId();
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    sector: "Infra",
    geography: "Pan India",
    complianceStatus: "compliant",
  });
  await db.insert(users).values({
    id: userId,
    email: "u@acme.local",
    passwordHash: await hashPassword("seed-password-123"),
    name: "Acme User",
    role: "company",
    companyId,
  });
  return { companyId, userId };
}

describe("transitionComplianceStatus → notification", () => {
  it("notifies the company's users on suspend", async () => {
    const { companyId, userId } = await seedActiveCompanyWithUser();

    const r = await transitionComplianceStatus({
      id: companyId,
      toStatus: "suspended",
    });
    expect(r.ok).toBe(true);

    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe("company_suspended");
    expect(notifs[0]?.link).toBe(`/dashboard/companies/${companyId}`);
    expect(notifs[0]?.readAt).toBeNull();
  });

  it("is a no-op when the company has no users", async () => {
    const companyId = newId();
    await db.insert(companies).values({
      id: companyId,
      name: "Empty Co",
      sector: "Infra",
      geography: "Pan India",
      complianceStatus: "compliant",
    });

    const r = await transitionComplianceStatus({
      id: companyId,
      toStatus: "suspended",
    });
    expect(r.ok).toBe(true);

    const all = await db.select().from(notifications);
    expect(all).toHaveLength(0);
  });
});
