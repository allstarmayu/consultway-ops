/**
 * R2 smoke test - verifies that the R2 client can mint a presigned PUT
 * URL, that the resulting URL is acceptable to Cloudflare's R2 endpoint,
 * and that a subsequent GET retrieves the same bytes.
 *
 * Run via:
 *   pnpm r2:smoke
 *
 * (equivalent to: cross-env NODE_OPTIONS=--use-system-ca tsx scripts/r2-smoke-test.ts)
 *
 * Requires the four R2_* env vars in .env.local. If they're set to the
 * placeholder defaults from lib/env.ts the upload will fail with a
 * SignatureDoesNotMatch error - that's the expected failure mode and
 * the message to look for if you're debugging credentials.
 *
 * Not a unit test - just a manual one-off. Real test coverage for the
 * action layer lands in Chunk 3 (Vitest with mocked R2).
 *
 * Windows + Node TLS workaround:
 *   Cloudflare R2's edge sometimes requests mid-handshake TLS
 *   renegotiation. Node's bundled undici fetch rejects this by default
 *   on Windows, producing an opaque "ssl3_read_bytes:ssl/tls alert
 *   handshake failure" error. The fix is to use the OS certificate
 *   trust store via Node's `--use-system-ca` flag, which the
 *   `pnpm r2:smoke` script in package.json sets via cross-env so the
 *   workaround travels with the invocation rather than the file.
 *
 *   This is dev-only. Production runs on Cloudflare Workers whose
 *   runtime fetch handles renegotiation and certificate trust natively.
 *
 * Cleanup:
 *   The smoke test leaves one artefact in R2 per run. Clean up via:
 *     wrangler r2 object delete "consultway-docs/<key>" --remote
 *   The exact command is printed at the end of a successful run.
 *
 * @module scripts/r2-smoke-test
 */
import "dotenv/config";
import { getPresignedPutUrl, getPresignedGetUrl } from "@/lib/r2/client";
import { buildDocumentKey } from "@/lib/r2/keys";

async function main(): Promise<void> {
  const companyId = "01931a8c-0000-7000-8000-000000000001";
  const documentId = "01931abc-0000-7000-8000-000000000002";
  const filename = "smoke-test.txt";
  const key = buildDocumentKey(companyId, documentId, filename);
  const mimeType = "text/plain";
  const bodyBytes = new TextEncoder().encode(
    `Consultway R2 smoke test at ${new Date().toISOString()}\n`,
  );

  // eslint-disable-next-line no-console
  console.log(`[smoke] key = ${key}`);

  // -- Step 1: mint a presigned PUT URL ------------------------------------
  const put = await getPresignedPutUrl(key, mimeType);
  // eslint-disable-next-line no-console
  console.log(`[smoke] PUT url length = ${put.url.length}`);

  // -- Step 2: actually upload -------------------------------------------
  const putResp = await fetch(put.url, {
    method: "PUT",
    headers: { "content-type": mimeType },
    body: bodyBytes,
  });
  if (!putResp.ok) {
    const text = await putResp.text();
    throw new Error(
      `PUT failed: ${putResp.status} ${putResp.statusText}\n${text}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[smoke] PUT ok: ${putResp.status}`);

  // -- Step 3: mint a presigned GET URL ----------------------------------
  const get = await getPresignedGetUrl(key);

  // -- Step 4: download and verify round-trip ----------------------------
  const getResp = await fetch(get.url, { method: "GET" });
  if (!getResp.ok) {
    const text = await getResp.text();
    throw new Error(
      `GET failed: ${getResp.status} ${getResp.statusText}\n${text}`,
    );
  }
  const downloaded = new Uint8Array(await getResp.arrayBuffer());
  const uploadedText = new TextDecoder().decode(bodyBytes);
  const downloadedText = new TextDecoder().decode(downloaded);

  if (uploadedText !== downloadedText) {
    throw new Error("Round-trip mismatch: uploaded bytes != downloaded bytes");
  }

  // eslint-disable-next-line no-console
  console.log(`[smoke] GET ok: ${downloadedText.trim()}`);

  // -- Step 5: report success + cleanup hint -----------------------------
  // The smoke test deliberately doesn't delete the artefact - that would
  // require minting a presigned DELETE URL (separate sigv4 signature shape
  // bound to the DELETE verb) which is mission creep for a smoke test.
  // Print the exact cleanup command instead so the caller can copy-paste.
  const bucket = process.env.R2_BUCKET_NAME ?? "consultway-docs";
  // eslint-disable-next-line no-console
  console.log("[smoke] success - R2 round-trip working");
  // eslint-disable-next-line no-console
  console.log(
    `[smoke] to clean up the artefact, run:\n` +
      `        wrangler r2 object delete "${bucket}/${key}" --remote`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
