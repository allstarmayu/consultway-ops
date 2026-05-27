/**
 * Integration tests for `lib/avatars/actions.ts`.
 *
 * Strategy mirrors `lib/documents/__tests__/actions.test.ts`:
 *   - Mock the R2 client (no real network calls). The mock surface is
 *     `getPresignedPutUrl` and `deleteR2Object` — the GET helper isn't
 *     touched by the actions under test.
 *   - Mock `readSession` only. Keep `assertUserExists` as the real
 *     implementation (via `importOriginal`) so the stale-session
 *     branch exercises the actual DB check.
 *   - Use the real db + audit log + schema — insert/update behaviour
 *     runs against the in-memory SQLite the dev `db` client opens.
 *
 * Coverage:
 *   initiateAvatarUpload
 *     - happy path: returns uploadUrl + avatarKey + contentType
 *     - refusal: not signed in
 *     - refusal: stale session
 *     - refusal: invalid mimeType (PDF)
 *     - refusal: oversize sizeBytes
 *     - refusal: unknown extra keys (strict)
 *
 *   confirmAvatarUpload
 *     - happy path: writes avatar_key, audits, R2 cleanup not called
 *       on first upload (no previousKey)
 *     - happy path: replaces previous key, audits, R2 cleanup called
 *       with the old key
 *     - no-op: same key submitted, no DB write, no audit
 *     - refusal: cross-user key (prefix mismatch)
 *     - refusal: not signed in
 *     - refusal: stale session
 *
 *   deleteAvatar
 *     - happy path: clears column, audits, R2 cleanup called
 *     - no-op: already null, no audit, no R2 call
 *     - refusal: not signed in
 *
 * @module lib/avatars/__tests__/actions
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, users, type UserRole } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

// ── Mocks ─────────────────────────────────────────────────────────────────

// Mock the R2 client BEFORE importing actions, so the import inside
// actions.ts picks up the mock. Vitest hoists `vi.mock` to the top.
vi.mock("@/lib/r2/client", () => ({
  getPresignedPutUrl: vi.fn(async (key: string, mimeType: string) => ({
    url: `https://mock-r2.invalid/${key}?ct=${encodeURIComponent(mimeType)}&signed=1`,
    expiresInSeconds: 300,
  })),
  getPresignedGetUrl: vi.fn(async (key: string) => ({
    url: `https://mock-r2.invalid/${key}?signed=1`,
    expiresInSeconds: 300,
  })),
  deleteR2Object: vi.fn(async (_key: string) => ({ ok: true, status: 204 })),
}));

// Keep `assertUserExists` real so the stale-session tests genuinely
// exercise the existence check.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    readSession: vi.fn(async () => null),
  };
});

import { readSession } from "@/lib/auth/session";
import { deleteR2Object, getPresignedPutUrl } from "@/lib/r2/client";
import {
  confirmAvatarUpload,
  deleteAvatar,
  initiateAvatarUpload,
} from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;
const mockedGetPut = getPresignedPutUrl as MockedFunction<
  typeof getPresignedPutUrl
>;
const mockedDelete = deleteR2Object as MockedFunction<typeof deleteR2Object>;

// ── Fixture ────────────────────────────────────────────────────────────────

interface Fixture {
  userId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const userId = newId();
  await db.insert(users).values({
    id: userId,
    email: `avatar-${userId}@test.local`,
    passwordHash: "$2a$10$test",
    role: "admin" as UserRole,
    name: "Avatar User",
  });
  return { userId };
}

async function clearFixture(f: Fixture): Promise<void> {
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, f.userId))
    .catch(() => {});
  await db.delete(users).where(eq(users.id, f.userId));
}

function loginAs(userId: string): void {
  mockedReadSession.mockResolvedValue({
    userId,
    role: "admin",
    companyId: null,
    email: `avatar-${userId}@test.local`,
  });
}

beforeEach(async () => {
  fixture = await seedFixture();
  mockedGetPut.mockClear();
  mockedDelete.mockClear();
});

afterEach(async () => {
  await clearFixture(fixture);
  mockedReadSession.mockReset();
  mockedReadSession.mockResolvedValue(null);
});

// ── initiateAvatarUpload ───────────────────────────────────────────────────

describe("initiateAvatarUpload", () => {
  it("returns { ok: false } when unauthenticated", async () => {
    const result = await initiateAvatarUpload({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
    });
    expect(result.ok).toBe(false);
  });

  it("returns a friendly error when the session points at a missing user", async () => {
    const ghostUserId = newId();
    mockedReadSession.mockResolvedValue({
      userId: ghostUserId,
      role: "admin",
      companyId: null,
      email: "ghost@test.local",
    });
    const result = await initiateAvatarUpload({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/session is no longer valid/i);
  });

  it("returns uploadUrl + avatarKey + contentType on success", async () => {
    loginAs(fixture.userId);
    const result = await initiateAvatarUpload({
      fileName: "selfie photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 200_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.avatarKey).toBe(
      `avatars/${fixture.userId}/selfie_photo.jpg`,
    );
    expect(result.uploadUrl).toContain(result.avatarKey);
    expect(result.contentType).toBe("image/jpeg");
    expect(mockedGetPut).toHaveBeenCalledTimes(1);
    expect(mockedGetPut).toHaveBeenCalledWith(
      result.avatarKey,
      "image/jpeg",
    );
  });

  it("rejects PDF mimeType (not in avatar allowlist)", async () => {
    loginAs(fixture.userId);
    const result = await initiateAvatarUpload({
      fileName: "doc.pdf",
      // @ts-expect-error — intentionally bad type
      mimeType: "application/pdf",
      sizeBytes: 100_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("mimeType");
    expect(mockedGetPut).not.toHaveBeenCalled();
  });

  it("rejects oversize files with field: 'sizeBytes'", async () => {
    loginAs(fixture.userId);
    const result = await initiateAvatarUpload({
      fileName: "huge.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10 * 1024 * 1024, // 10 MB — above the 5 MB cap
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("sizeBytes");
    expect(mockedGetPut).not.toHaveBeenCalled();
  });

  it("rejects unknown extra keys (strict schema)", async () => {
    loginAs(fixture.userId);
    const result = await initiateAvatarUpload({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      userId: "should-not-be-accepted",
    } as unknown as { fileName: string; mimeType: "image/jpeg"; sizeBytes: number });
    expect(result.ok).toBe(false);
    expect(mockedGetPut).not.toHaveBeenCalled();
  });
});

// ── confirmAvatarUpload ────────────────────────────────────────────────────

describe("confirmAvatarUpload", () => {
  it("returns { ok: false } when unauthenticated", async () => {
    const result = await confirmAvatarUpload({
      avatarKey: `avatars/${fixture.userId}/photo.jpg`,
    });
    expect(result.ok).toBe(false);
  });

  it("returns a friendly error when the session points at a missing user", async () => {
    const ghostUserId = newId();
    mockedReadSession.mockResolvedValue({
      userId: ghostUserId,
      role: "admin",
      companyId: null,
      email: "ghost@test.local",
    });
    const result = await confirmAvatarUpload({
      avatarKey: `avatars/${ghostUserId}/photo.jpg`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/session is no longer valid/i);
  });

  it("rejects a cross-user avatar key (prefix mismatch)", async () => {
    loginAs(fixture.userId);
    const otherUserId = newId();
    const result = await confirmAvatarUpload({
      avatarKey: `avatars/${otherUserId}/photo.jpg`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("avatarKey");
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("writes the column + audit on first upload (no previousKey, no R2 cleanup)", async () => {
    loginAs(fixture.userId);
    const key = `avatars/${fixture.userId}/photo.jpg`;
    const result = await confirmAvatarUpload({ avatarKey: key });
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.avatarKey).toBe(key);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.before).toEqual({ avatarKey: null });
    expect(auditRows[0]!.after).toEqual({ avatarKey: key });

    // No previous key → no R2 cleanup call.
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("replaces a previous key and best-effort deletes the old R2 object", async () => {
    loginAs(fixture.userId);
    const firstKey = `avatars/${fixture.userId}/old.jpg`;
    const secondKey = `avatars/${fixture.userId}/new.png`;
    await confirmAvatarUpload({ avatarKey: firstKey });
    mockedDelete.mockClear();

    const result = await confirmAvatarUpload({ avatarKey: secondKey });
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.avatarKey).toBe(secondKey);

    expect(mockedDelete).toHaveBeenCalledTimes(1);
    expect(mockedDelete).toHaveBeenCalledWith(firstKey);
  });

  it("short-circuits when the submitted key matches the persisted one", async () => {
    loginAs(fixture.userId);
    const key = `avatars/${fixture.userId}/photo.jpg`;
    await confirmAvatarUpload({ avatarKey: key });
    mockedDelete.mockClear();

    // Same key again — should no-op the DB and audit.
    const result = await confirmAvatarUpload({ avatarKey: key });
    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    // Only the initial confirm's audit row, not a second.
    expect(auditRows).toHaveLength(1);
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});

// ── deleteAvatar ───────────────────────────────────────────────────────────

describe("deleteAvatar", () => {
  it("returns { ok: false } when unauthenticated", async () => {
    const result = await deleteAvatar();
    expect(result.ok).toBe(false);
  });

  it("clears the column + audits + deletes the R2 object on a real avatar", async () => {
    loginAs(fixture.userId);
    const key = `avatars/${fixture.userId}/photo.jpg`;
    await confirmAvatarUpload({ avatarKey: key });
    mockedDelete.mockClear();

    const result = await deleteAvatar();
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.avatarKey).toBeNull();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    // confirm row + delete row.
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
    const sorted = [...auditRows].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const latest = sorted[sorted.length - 1]!;
    expect(latest.before).toEqual({ avatarKey: key });
    expect(latest.after).toEqual({ avatarKey: null });

    expect(mockedDelete).toHaveBeenCalledTimes(1);
    expect(mockedDelete).toHaveBeenCalledWith(key);
  });

  it("short-circuits when the avatar is already null (no audit, no R2 call)", async () => {
    loginAs(fixture.userId);
    const result = await deleteAvatar();
    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    expect(auditRows).toHaveLength(0);
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});
