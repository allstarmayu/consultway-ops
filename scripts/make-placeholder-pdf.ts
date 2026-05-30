/**
 * Generate a minimal, valid single-page PDF — used to populate staging R2
 * with placeholder objects so the document-download flow is end-to-end
 * testable. The seeded `documents` rows reference R2 keys that otherwise
 * 404; uploading this placeholder under a sample of those keys makes the
 * download path return real bytes.
 *
 * Pure + dependency-free: builds the PDF byte-for-byte with a correct
 * cross-reference table — no `@react-pdf/renderer` / `pdf-lib` needed
 * (and none of the workerd WASM baggage that retired the server PDF
 * route on Day 31). `buildPlaceholderPdf` is exported and unit-tested.
 *
 * Usage:
 *   tsx scripts/make-placeholder-pdf.ts \
 *     --out=.wrangler/r2-placeholders/placeholder.pdf [--text="..."]
 *
 * @module scripts/make-placeholder-pdf
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "make-placeholder-pdf" });

const DEFAULT_TEXT = "Consultway Ops - staging placeholder document";

/**
 * Build a minimal, valid single-page PDF rendering one line of text.
 *
 * The content is forced to ASCII: the cross-reference offsets are computed
 * from string length, which equals byte length only for single-byte
 * encodings (the result is written as `latin1` to preserve that). PDF
 * string metacharacters `(`, `)`, `\` are stripped so the content stream
 * stays well-formed.
 *
 * @param text - single line to render (non-ASCII + PDF-unsafe chars dropped)
 * @returns the PDF file bytes
 */
export function buildPlaceholderPdf(text: string = DEFAULT_TEXT): Buffer {
  const safe = text.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, "");
  const content = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = body.length;
  const count = objects.length + 1; // +1 for the mandatory free object 0
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${count} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, "latin1");
}

/** Write a placeholder PDF to the `--out` path, creating parent dirs. */
function main(): void {
  const out = requireArg("--out=");
  const text = readArg("--text=") ?? DEFAULT_TEXT;
  const pdf = buildPlaceholderPdf(text);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, pdf);
  log.info("placeholder PDF written", { out, bytes: pdf.length });
}

function readArg(prefix: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function requireArg(prefix: string): string {
  const value = readArg(prefix);
  if (!value) {
    throw new Error(`make-placeholder-pdf: ${prefix}<path> is required`);
  }
  return value;
}

if (!process.env.VITEST) {
  try {
    main();
  } catch (err) {
    log.error("failed to write placeholder PDF", { err });
    process.exitCode = 1;
  }
}
