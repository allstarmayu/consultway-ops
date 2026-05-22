/**
 * Cloudflare R2 client - presigned URL minting.
 *
 * R2 is S3-API compatible, so we sign requests with AWS Signature
 * Version 4 (sigv4) the same way we would for S3. The `aws4fetch`
 * library is the smallest, runtime-agnostic sigv4 implementation -
 * it works in Node, in Cloudflare Workers, and in the browser, all
 * with a single `fetch`-shaped API.
 *
 * What this module does:
 *   - `getPresignedPutUrl(key, mimeType)` - mint a short-lived URL the
 *     browser can `PUT` bytes to. Used by `initiateDocumentUpload`
 *     (Chunk 3) to hand the client a direct-to-R2 upload target.
 *   - `getPresignedGetUrl(key)` - mint a short-lived URL anyone holding
 *     it can `GET` to download the object. Used by the eventual
 *     download UI (Day 10) and by re-display flows.
 *
 * What this module does NOT do:
 *   - Stream bytes through our server. Both flows are designed for the
 *     browser to talk to R2 directly, bypassing our Worker. That sidesteps
 *     the Workers 100 MB request limit and saves egress + CPU.
 *   - Validate the key format. Callers must produce keys via
 *     `lib/r2/keys.ts::buildDocumentKey`, which is the canonical source
 *     for the `companies/{companyId}/{documentId}/{filename}` shape.
 *   - Verify the object exists in R2 before signing a GET. A "GET URL
 *     for a non-existent key" is fine - the URL just fails with 404
 *     when used. Pre-checking would cost an extra round-trip per
 *     download.
 *
 * Sigv4 design choices, called out for the future-reader:
 *   - `signQuery: true` puts the signature in URL query params (X-Amz-*)
 *     instead of an Authorization header. Browsers can't set custom
 *     headers on a redirect-followed PUT to a third-party origin, so the
 *     query-param form is the only direct-upload flow that works.
 *   - PUT URLs sign the `content-type` header at sign time. The browser
 *     MUST send the same Content-Type on the actual upload, or R2 rejects
 *     with a sigv4 mismatch. The action layer (Chunk 3) returns the
 *     content-type to the client so the upload code can set it correctly.
 *   - GET URLs do NOT sign content-type - reads don't have a body, so
 *     there's nothing to bind.
 *   - Expiry is 5 minutes for PUT (uploads should be quick) and 5 minutes
 *     for GET (downloads happen on click, no reason for a longer window
 *     than necessary). Configurable per-call via the `expiresInSeconds`
 *     argument.
 *
 * Lazy client construction:
 *   The `AwsClient` constructor is called the first time a sign operation
 *   is invoked, not at module load. This lets `pnpm dev` boot in
 *   environments where R2 credentials haven't been set yet (placeholder
 *   values from `lib/env.ts` get the app running; the first real R2 call
 *   fails loudly with a sigv4 error, which is the desired failure mode).
 *
 * @module lib/r2/client
 */
import { AwsClient } from "aws4fetch";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "r2" });

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Default expiry for presigned URLs in seconds. Five minutes is long
 * enough for a user to actually do the upload (slow connections, big
 * files), short enough that a leaked URL has minimal blast radius.
 */
const DEFAULT_EXPIRY_SECONDS = 300;

/**
 * The S3-compatible R2 endpoint. R2's endpoint URL contains the account
 * ID as a hex subdomain; the bucket name is part of the path, not the
 * host. (This differs from AWS S3 where path-style and virtual-hosted
 * style differ - R2 uses path-style.)
 */
function getEndpoint(): string {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

// ── Lazy client ────────────────────────────────────────────────────────────

/**
 * Module-scoped singleton. `null` until the first sign operation.
 * See top-of-file commentary for why we defer construction.
 */
let cachedClient: AwsClient | null = null;

/**
 * Build (or return cached) `AwsClient` configured for our R2 account.
 *
 * Service is `"s3"` (not `"r2"`) because that's the service name in the
 * sigv4 canonical request that R2 expects - it's emulating S3.
 *
 * Region is `"auto"` for R2. R2 doesn't have regions in the AWS sense;
 * `"auto"` is the magic string Cloudflare's docs specify for sigv4
 * signing against any R2 bucket.
 */
function getClient(): AwsClient {
  if (cachedClient !== null) return cachedClient;

  cachedClient = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  log.debug("r2 client initialised", {
    bucket: env.R2_BUCKET_NAME,
    // Account ID is non-secret; access key id is non-secret. The
    // secret access key never lands in any log payload.
    accountId: env.R2_ACCOUNT_ID,
  });

  return cachedClient;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Result type for presign operations. Returning a typed object (rather
 * than a bare string) lets us add fields later (e.g. an actual `headers`
 * object the client must echo back) without breaking call sites.
 */
export interface PresignedUrlResult {
  /** The fully-signed URL with query-string credentials baked in. */
  url: string;
  /** Seconds until the URL stops being valid. */
  expiresInSeconds: number;
}

/**
 * Mint a presigned URL for uploading bytes to R2.
 *
 * The client calling this URL MUST send the same `Content-Type` header
 * value passed in here - sigv4 binds the content type into the signature,
 * and R2 will reject a mismatched upload with a `SignatureDoesNotMatch`
 * error. The action layer in Chunk 3 returns the expected content type
 * to the browser so the upload code can set it correctly.
 *
 * @param key - R2 object key (the full path within the bucket).
 *              Construct via `buildDocumentKey` in `./keys.ts`.
 * @param mimeType - The Content-Type the client will send on PUT.
 *                   Must match exactly; case-sensitive after sigv4
 *                   canonicalisation.
 * @param expiresInSeconds - URL lifetime; defaults to 5 minutes.
 *                           Capped at 7 days by R2 (sigv4 max), but
 *                           we don't enforce that here - caller's
 *                           responsibility.
 * @returns The presigned URL and its expiry.
 */
export async function getPresignedPutUrl(
  key: string,
  mimeType: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<PresignedUrlResult> {
  const client = getClient();
  const url = `${getEndpoint()}/${env.R2_BUCKET_NAME}/${key}`;

  // Build the request whose signature we'll embed in the query string.
  // The browser will issue an equivalent PUT to the signed URL; sigv4
  // requires method, path, content-type, and the X-Amz-Expires param
  // all to match between sign-time and use-time.
  const request = new Request(url, {
    method: "PUT",
    headers: { "content-type": mimeType },
  });

  // `signQuery: true` puts X-Amz-Signature in the query string instead
  // of the Authorization header - the only form a browser can actually
  // use for direct-to-R2 uploads.
  //
  // `expiresIn` is set on the underlying signer via the standard
  // `X-Amz-Expires` query param. aws4fetch picks it up from a URL
  // search param, which we append on the input request below.
  const signedUrl = new URL(url);
  signedUrl.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const signed = await client.sign(
    new Request(signedUrl.toString(), request),
    { aws: { signQuery: true } },
  );

  log.info("presigned put url minted", {
    key,
    mimeType,
    expiresInSeconds,
  });

  return { url: signed.url, expiresInSeconds };
}

/**
 * Mint a presigned URL for downloading bytes from R2.
 *
 * Same shape as `getPresignedPutUrl` but for GETs. No content-type to
 * bind (reads have no body). The browser fetches the URL directly;
 * R2 streams the bytes with the stored `Content-Type` from the upload.
 *
 * Caller is responsible for verifying the document row's RBAC visibility
 * before calling - this function will happily sign a URL for any key,
 * including keys that don't exist (the URL will then 404 at use time).
 *
 * @param key - R2 object key. Must match the key recorded in the
 *              `documents.fileKey` column.
 * @param expiresInSeconds - URL lifetime; defaults to 5 minutes.
 * @returns The presigned URL and its expiry.
 */
export async function getPresignedGetUrl(
  key: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<PresignedUrlResult> {
  const client = getClient();
  const url = `${getEndpoint()}/${env.R2_BUCKET_NAME}/${key}`;

  const signedUrl = new URL(url);
  signedUrl.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const signed = await client.sign(
    new Request(signedUrl.toString(), { method: "GET" }),
    { aws: { signQuery: true } },
  );

  log.info("presigned get url minted", {
    key,
    expiresInSeconds,
  });

  return { url: signed.url, expiresInSeconds };
}
