/**
 * Application shortlisted notification email.
 *
 * Sent to the applying company's `contactEmail` when a staff/admin user
 * moves their tender application from `submitted` to `shortlisted`. Pure
 * render function - no I/O, no DB, no Resend. Returns the rendered
 * `{ subject, html, text }` triplet the `updateApplicationStatus`
 * Server Action hands to `sendEmail`.
 *
 * Tone: actively positive but careful. A shortlist is good news but does
 * NOT guarantee an award - the copy should congratulate the applicant on
 * advancing while keeping expectations realistic ("under final
 * consideration", not "you've won").
 *
 * Shape mirrors `document-expiry-reminder.ts`:
 *   - inline-styled HTML, table layout, ~600px wide
 *   - plain-text fallback
 *   - `escapeHtml` interpolation guard
 *   - deep-link button back to the application's tender detail page
 *
 * @module lib/email/templates/application-shortlisted
 */

// ── Inputs ────────────────────────────────────────────────────────────────

export interface ApplicationShortlistedInput {
  /** Application this notification is about. */
  application: {
    id: string;
    submittedAt: string; // ISO-8601 UTC
  };

  /** Tender the application targeted. */
  tender: {
    id: string;
    title: string;
    referenceNumber: string | null;
    closingDate: string | null; // YYYY-MM-DD
  };

  /** Owning company - for the greeting and deep-link context. */
  company: {
    id: string;
    name: string;
  };

  /**
   * Base URL of the app. Same `env.NEXT_PUBLIC_APP_URL` shape the cron
   * uses. Caller supplies it so the template stays pure.
   */
  appUrl: string;
}

// ── Output ────────────────────────────────────────────────────────────────

export interface ApplicationShortlistedOutput {
  subject: string;
  html: string;
  text: string;
}

// ── Render ────────────────────────────────────────────────────────────────

/**
 * Render the application-shortlisted email.
 */
export function renderApplicationShortlistedEmail(
  input: ApplicationShortlistedInput,
): ApplicationShortlistedOutput {
  const detailUrl = `${input.appUrl}/dashboard/tenders/${input.tender.id}`;

  const refSuffix = input.tender.referenceNumber
    ? ` (${input.tender.referenceNumber})`
    : "";

  const subject = `Your application for "${input.tender.title}" has been shortlisted`;

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
                  Your application has been shortlisted
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.company.name)} team,
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Good news - your application for <strong>${escapeHtml(input.tender.title)}</strong>${escapeHtml(refSuffix)} is under final consideration. We'll be in touch with the next steps shortly.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0; background:#faf6f0; border-radius:8px; padding:16px;">
                  <tr>
                    <td style="font-size:13px; color:#6b5b4a; padding-bottom:4px;">Tender</td>
                  </tr>
                  <tr>
                    <td style="font-size:15px; font-weight:500; color:#3d2f1f; padding-bottom:12px;">
                      ${escapeHtml(input.tender.title)}
                    </td>
                  </tr>
                  ${
                    input.tender.closingDate
                      ? `<tr>
                    <td style="font-size:13px; color:#6b5b4a; padding-bottom:4px;">Closing date</td>
                  </tr>
                  <tr>
                    <td style="font-size:15px; font-weight:500; color:#3d2f1f;">
                      ${escapeHtml(input.tender.closingDate)}
                    </td>
                  </tr>`
                      : ""
                  }
                </table>

                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:#3d2f1f; border-radius:6px;">
                      <a href="${escapeHtml(detailUrl)}" style="display:inline-block; padding:12px 20px; font-size:15px; font-weight:500; color:#ffffff; text-decoration:none;">
                        View tender details
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:32px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  Being shortlisted means your application is among those under final review. The award decision will follow once evaluation is complete.
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

  const text = [
    `Hi ${input.company.name} team,`,
    "",
    `Good news - your application for "${input.tender.title}"${refSuffix} is under final consideration.`,
    "We'll be in touch with the next steps shortly.",
    "",
    `Tender: ${input.tender.title}`,
    ...(input.tender.closingDate
      ? [`Closing date: ${input.tender.closingDate}`]
      : []),
    "",
    `View tender details: ${detailUrl}`,
    "",
    "Being shortlisted means your application is among those under final review. The award decision will follow once evaluation is complete.",
    "",
    "-- Consultway Infotech",
  ].join("\n");

  return { subject, html, text };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Escape user-supplied strings for safe HTML interpolation. Duplicated
 * across templates rather than lifted to a shared helper - each template
 * is self-contained, and the function is six lines. If a fourth template
 * lands, hoist it.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
