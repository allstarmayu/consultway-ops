/**
 * Unit tests for the R2 key helpers.
 *
 * Pure-function tests, no I/O. These two helpers are load-bearing for
 * every document upload - mistakes here would corrupt R2 keys in
 * subtle ways that don't surface until a download fails.
 *
 * @module lib/r2/__tests__/keys
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  buildDocumentKey,
  buildAvatarKey,
  avatarKeyPrefixFor,
} from "./keys";

describe("sanitizeFilename", () => {
  // â”€â”€ Happy path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("passes a clean filename through unchanged", () => {
    expect(sanitizeFilename("gst-cert.pdf")).toBe("gst-cert.pdf");
  });

  it("preserves common safe punctuation", () => {
    expect(sanitizeFilename("doc_v2(final).pdf")).toBe("doc_v2(final).pdf");
  });

  it("preserves digits and case", () => {
    expect(sanitizeFilename("Q4-2026_Report.PDF")).toBe(
      "Q4-2026_Report.PDF",
    );
  });

  // â”€â”€ Sanitisation rules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("replaces forward slashes with hyphens", () => {
    expect(sanitizeFilename("path/to/file.pdf")).toBe("path-to-file.pdf");
  });

  it("replaces backslashes with hyphens", () => {
    expect(sanitizeFilename("path\\to\\file.pdf")).toBe(
      "path-to-file.pdf",
    );
  });

  it("replaces quotes with hyphens", () => {
    expect(sanitizeFilename(`"quoted".pdf`)).toBe("-quoted-.pdf");
    expect(sanitizeFilename(`'apostrophe'.pdf`)).toBe(
      "-apostrophe-.pdf",
    );
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("file\x00name\x1f.pdf")).toBe("filename.pdf");
  });

  it("collapses whitespace runs to a single underscore", () => {
    expect(sanitizeFilename("file   with    spaces.pdf")).toBe(
      "file_with_spaces.pdf",
    );
  });

  it("trims leading and trailing whitespace before processing", () => {
    expect(sanitizeFilename("   spaced.pdf   ")).toBe("spaced.pdf");
  });

  it("strips leading dots (prevents Unix-hidden filenames)", () => {
    expect(sanitizeFilename("...hidden.pdf")).toBe("hidden.pdf");
  });

  // â”€â”€ Length cap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("caps very long filenames at 200 chars", () => {
    const input = "a".repeat(500) + ".pdf";
    const result = sanitizeFilename(input);
    expect(result.length).toBe(200);
  });

  // â”€â”€ Edge cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("returns 'file' fallback for empty input", () => {
    expect(sanitizeFilename("")).toBe("file");
  });

  it("returns 'file' fallback for whitespace-only input", () => {
    expect(sanitizeFilename("   ")).toBe("file");
  });

  it("returns 'file' fallback when sanitisation strips everything", () => {
    // Just slashes - all replaced to hyphens, leaving just hyphens.
    // Hyphens are preserved punctuation, so this should be hyphens.
    expect(sanitizeFilename("///")).toBe("---");
    // Just control chars - all stripped, leaves empty.
    expect(sanitizeFilename("\x00\x01\x02")).toBe("file");
  });

  it("handles non-ASCII letters (UTF-8 preserved)", () => {
    // R2 keys are UTF-8 capable; the sanitiser shouldn't mangle these.
    expect(sanitizeFilename("à¤¶à¥à¤²à¥à¤•.pdf")).toBe("à¤¶à¥à¤²à¥à¤•.pdf");
  });
});

describe("buildDocumentKey", () => {
  const COMPANY_ID = "01931a8c-0000-7000-8000-000000000001";
  const DOCUMENT_ID = "01931abc-0000-7000-8000-000000000002";

  it("composes the canonical key format", () => {
    expect(buildDocumentKey(COMPANY_ID, DOCUMENT_ID, "gst.pdf")).toBe(
      `companies/${COMPANY_ID}/${DOCUMENT_ID}/gst.pdf`,
    );
  });

  it("sanitises the filename component", () => {
    const key = buildDocumentKey(
      COMPANY_ID,
      DOCUMENT_ID,
      "GST Cert 2026.pdf",
    );
    expect(key).toBe(
      `companies/${COMPANY_ID}/${DOCUMENT_ID}/GST_Cert_2026.pdf`,
    );
  });

  it("does not let path-separator filenames escape the per-document prefix", () => {
    const key = buildDocumentKey(
      COMPANY_ID,
      DOCUMENT_ID,
      "../../../etc/passwd",
    );
    // The dots and slashes get processed. Critical guarantee: the key
    // does NOT contain `/..` which could be interpreted as a parent
    // path traversal.
    expect(key).toBe(
      `companies/${COMPANY_ID}/${DOCUMENT_ID}/-..-..-etc-passwd`,
    );
    expect(key.startsWith(`companies/${COMPANY_ID}/${DOCUMENT_ID}/`)).toBe(
      true,
    );
    expect(key).not.toContain("/..");
  });

  it("throws on missing companyId", () => {
    expect(() => buildDocumentKey("", DOCUMENT_ID, "file.pdf")).toThrow();
  });

  it("throws on missing documentId", () => {
    expect(() => buildDocumentKey(COMPANY_ID, "", "file.pdf")).toThrow();
  });

  it("returns 'file' fallback for empty filename", () => {
    const key = buildDocumentKey(COMPANY_ID, DOCUMENT_ID, "");
    expect(key).toBe(`companies/${COMPANY_ID}/${DOCUMENT_ID}/file`);
  });
});

describe("buildAvatarKey", () => {
  const USER_ID = "019e5752-b562-743d-a122-a650ac8cb85a";

  it("composes the canonical avatar key format", () => {
    expect(buildAvatarKey(USER_ID, "photo.jpg")).toBe(
      `avatars/${USER_ID}/photo.jpg`,
    );
  });

  it("sanitises the filename component", () => {
    expect(buildAvatarKey(USER_ID, "selfie photo.jpg")).toBe(
      `avatars/${USER_ID}/selfie_photo.jpg`,
    );
  });

  it("does not let path-separator filenames escape the per-user prefix", () => {
    const key = buildAvatarKey(USER_ID, "../../../etc/passwd.jpg");
    // Critical guarantee: the key cannot escape the per-user prefix —
    // the action's authorization gate (`startsWith(avatars/{userId}/)`)
    // depends on this.
    expect(key.startsWith(`avatars/${USER_ID}/`)).toBe(true);
    expect(key).not.toContain("/..");
  });

  it("throws on missing userId", () => {
    expect(() => buildAvatarKey("", "photo.jpg")).toThrow();
  });

  it("returns 'file' fallback for empty filename", () => {
    expect(buildAvatarKey(USER_ID, "")).toBe(`avatars/${USER_ID}/file`);
  });
});

describe("avatarKeyPrefixFor", () => {
  const USER_ID = "019e5752-b562-743d-a122-a650ac8cb85a";

  it("returns the canonical prefix with trailing slash", () => {
    expect(avatarKeyPrefixFor(USER_ID)).toBe(`avatars/${USER_ID}/`);
  });

  it("composes consistently with buildAvatarKey", () => {
    // The auth check in `confirmAvatarUpload` does
    // `avatarKey.startsWith(avatarKeyPrefixFor(userId))` — this test
    // pins the invariant the two helpers must satisfy together.
    const key = buildAvatarKey(USER_ID, "any-photo.png");
    expect(key.startsWith(avatarKeyPrefixFor(USER_ID))).toBe(true);
  });

  it("throws on missing userId", () => {
    expect(() => avatarKeyPrefixFor("")).toThrow();
  });
});


