/**
 * Document expiry-reminder email template.
 *
 * Pure render function - no I/O, no DB, no Resend. Returns the rendered
 * `{ subject, html, text }` triplet that the cron handler hands to
 * `sendEmail`. Inline-styled to survive Outlook / Gmail / corporate
 * webmail rendering without an external stylesheet, and without dragging
 * in a templating dep.
 *
 * Why no React Email:
 *   `@react-email` is the established Next/React option for
 *   transactional emails, but it's a ~3 MB dep and Phase 1 has exactly
 *   one outbound email type. A 50-line hand-rolled HTML template is
 *   strictly simpler at this scale. If we grow to ~5 templates,
 *   revisit.
 *
 * Email clients matter:
 *   - Tables for layout (Outlook's old engine doesn't do flex/grid).
 *   - Inline styles (Gmail strips `<style>` blocks in some quoted
 *     replies, and corporate filters add their own CSS).
 *   - Plain-text fallback (accessibility + text-only mail clients).
 *
 * @module lib/email/templates/document-expiry-reminder
 */

import { DOCUMENT_TYPE_LABELS } from "@/lib/documents/labels";
import type { DocumentType } from "@/lib/db/schema";

// ── Inputs ────────────────────────────────────────────────────────────────

export interface ExpiryReminderInput {
  /** Document this reminder is about. */
  document: {
    id: string;
    fileName: string;
    documentType: DocumentType;
    expiresAt: string; // YYYY-MM-DD
  };

  /** Owning company - for the greeting + the deep-link URL. */
  company: {
    id: string;
    name: string;
  };

  /**
   * Days remaining until expiry. Positive number; the cron only calls
   * this template for rows with `expiresAt > today`. Past-expiry rows
   * are handled separately (status flip, no email).
   */
  daysToExpiry: number;

  /**
   * Base URL of the app, used to construct the deep-link back to the
   * company's documents view. From `env.NEXT_PUBLIC_APP_URL`.
   */
  appUrl: string;
}

// ── Output ────────────────────────────────────────────────────────────────

export interface ExpiryReminderOutput {
  subject: string;
  html: string;
  text: string;
}

// ── Render ────────────────────────────────────────────────────────────────

/**
 * Render the expiry-reminder email.
 *
 * Subject phrasing leans on urgency in the day count: "expires in 30
 * days" reads differently from "expires tomorrow" even though both
 * are valid inputs. We tier the subject for clarity.
 */
export function renderExpiryReminderEmail(
  input: ExpiryReminderInput,
): ExpiryReminderOutput {
  const typeLabel = DOCUMENT_TYPE_LABELS[input.document.documentType];
  const detailUrl = `${input.appUrl}/dashboard/companies/${input.company.id}`;

  const urgencyPhrase =
    input.daysToExpiry === 1
      ? "expires tomorrow"
      : input.daysToExpiry <= 7
        ? `expires in ${input.daysToExpiry} days`
        : `expires in ${input.daysToExpiry} days`;

  const subject = `${typeLabel} ${urgencyPhrase} - ${input.company.name}`;

  // Inline-styled HTML. Single-column table layout (~600 px wide) is
  // the standard email shape - readable on mobile, supported by every
  // mail client.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0; padding:0; background:#faf6f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#2d2620;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf6f0;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px; background:#ffffff; border-radius:12px; border:1px solid #e8dccb; padding:32px;">
            <tr>
              <td>
                <h1 style="margin:0 0 16px 0; font-size:20px; font-weight:600; color:#3d2f1f;">
                  Document expiring soon
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.company.name)} team,
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Your <strong>${escapeHtml(typeLabel)}</strong> on file with Consultway ${urgencyPhrase} (${escapeHtml(input.document.expiresAt)}). To stay compliant, please upload a renewed copy before the expiry date.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0; background:#faf6f0; border-radius:8px; padding:16px;">
                  <tr>
                    <td style="font-size:13px; color:#6b5b4a; padding-bottom:4px;">File</td>
                  </tr>
                  <tr>
                    <td style="font-size:15px; font-weight:500; color:#3d2f1f; padding-bottom:12px;">
                      ${escapeHtml(input.document.fileName)}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:13px; color:#6b5b4a; padding-bottom:4px;">Expires</td>
                  </tr>
                  <tr>
                    <td style="font-size:15px; font-weight:500; color:${input.daysToExpiry <= 7 ? "#b5483a" : "#3d2f1f"};">
                      ${escapeHtml(input.document.expiresAt)} (${urgencyPhrase})
                    </td>
                  </tr>
                </table>

                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:#3d2f1f; border-radius:6px;">
                      <a href="${escapeHtml(detailUrl)}" style="display:inline-block; padding:12px 20px; font-size:15px; font-weight:500; color:#ffffff; text-decoration:none;">
                        Upload a new copy
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:32px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  If you've already renewed this document, you can ignore this email - it will stop sending as soon as the new copy is verified.
                </p>
              </td>
            </tr>
          </table>

          <p style="margin:16px 0 0 0; font-size:12px; color:#9b8b7a; text-align:center;">
            Consultway Infotech - Operations Platform
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  // Plain-text fallback. Same content, no markup, line-wrapped for
  // mail clients that show monospace by default.
  const text = [
    `Hi ${input.company.name} team,`,
    "",
    `Your ${typeLabel} on file with Consultway ${urgencyPhrase} (${input.document.expiresAt}).`,
    "To stay compliant, please upload a renewed copy before the expiry date.",
    "",
    `File:    ${input.document.fileName}`,
    `Expires: ${input.document.expiresAt} (${urgencyPhrase})`,
    "",
    `Upload a new copy: ${detailUrl}`,
    "",
    "If you've already renewed this document, ignore this email - it will stop sending as soon as the new copy is verified.",
    "",
    "-- Consultway Infotech",
  ].join("\n");

  return { subject, html, text };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Escape user-supplied strings for safe HTML interpolation. We render
 * company / filename / date values into the HTML body, and a company
 * named e.g. `Acme & Co. <Mumbai>` would otherwise break the markup
 * (and in pathological cases let through HTML injection).
 *
 * Keeping a tiny hand-rolled escaper over importing a library because
 * the surface here is 5 chars; @nf/htmlencoder etc. is overkill.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
