/**
 * Application rejected notification email.
 *
 * Sent to the applying company's `contactEmail` when a staff/admin user
 * moves their tender application from `submitted` to `rejected`. Pure
 * render function - no I/O, no DB, no Resend.
 *
 * Tone: neutral and forward-looking, NOT apologetic or terminal. A
 * rejected applicant should leave the email feeling respected and
 * encouraged to bid on future tenders. We deliberately avoid:
 *   - "We're sorry to inform you..." (sounds like a layoff letter)
 *   - "Your application was not successful" (vague + final)
 *   - "You didn't qualify" (judgmental)
 * Preferred phrasing: "not selected for this opportunity" - clear that
 * THIS decision is about THIS tender, not about the company as a whole.
 *
 * We do NOT include the staff's `internalNotes` in the email payload -
 * those are admin-only working notes (rationale: a curt reviewer note
 * like "missing eligibility documents" would land badly in a customer-
 * facing email even when factually correct). If we ever want to surface
 * a public-facing rejection reason, that's a separate column with its
 * own UX consideration.
 *
 * Shape mirrors `application-shortlisted.ts`.
 *
 * @module lib/email/templates/application-rejected
 */

// ── Inputs ────────────────────────────────────────────────────────────────

export interface ApplicationRejectedInput {
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
  };

  /** Owning company - for the greeting and deep-link context. */
  company: {
    id: string;
    name: string;
  };

  /** Base URL of the app. From `env.NEXT_PUBLIC_APP_URL`. */
  appUrl: string;
}

// ── Output ────────────────────────────────────────────────────────────────

export interface ApplicationRejectedOutput {
  subject: string;
  html: string;
  text: string;
}

// ── Render ────────────────────────────────────────────────────────────────

/**
 * Render the application-rejected email.
 */
export function renderApplicationRejectedEmail(
  input: ApplicationRejectedInput,
): ApplicationRejectedOutput {
  const browseUrl = `${input.appUrl}/dashboard/tenders`;

  const refSuffix = input.tender.referenceNumber
    ? ` (${input.tender.referenceNumber})`
    : "";

  // Subject avoids "rejected" - too blunt for a transactional header.
  // "Update on" is neutral and reads as an informational notice.
  const subject = `Update on your application for "${input.tender.title}"`;

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
                  Application status update
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.company.name)} team,
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Thank you for applying to <strong>${escapeHtml(input.tender.title)}</strong>${escapeHtml(refSuffix)}. After review, your application was not selected for this opportunity.
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  We appreciate the time you took to apply and encourage you to consider future tenders that match your profile. New opportunities are added regularly.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
                  <tr>
                    <td style="background:#3d2f1f; border-radius:6px;">
                      <a href="${escapeHtml(browseUrl)}" style="display:inline-block; padding:12px 20px; font-size:15px; font-weight:500; color:#ffffff; text-decoration:none;">
                        Browse open tenders
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:32px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  If you have questions about this decision, please reply to this email and our team will follow up.
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
    `Thank you for applying to "${input.tender.title}"${refSuffix}. After review, your application was not selected for this opportunity.`,
    "",
    "We appreciate the time you took to apply and encourage you to consider future tenders that match your profile. New opportunities are added regularly.",
    "",
    `Browse open tenders: ${browseUrl}`,
    "",
    "If you have questions about this decision, please reply to this email and our team will follow up.",
    "",
    "-- Consultway Infotech",
  ].join("\n");

  return { subject, html, text };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
