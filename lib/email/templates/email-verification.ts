/**
 * Email verification message.
 *
 * Sent to the registering user's login email immediately after
 * `registerCompany` mints a verification token. Pure render function -
 * no I/O. Returns the rendered `{ subject, html, text }` triplet the
 * register action hands to `sendEmail`.
 *
 * Shape mirrors `application-shortlisted.ts`:
 *   - inline-styled HTML, table layout, ~600px wide
 *   - plain-text fallback
 *   - inline `escapeHtml` interpolation guard
 *   - single CTA button to the verification URL
 *
 * @module lib/email/templates/email-verification
 */

// ── Inputs ────────────────────────────────────────────────────────────────

export interface EmailVerificationInput {
  /** The new user. Used for the greeting. */
  user: {
    name: string;
    email: string;
  };
  /** Fully-qualified `/auth/verify?token=<raw>` URL. */
  verifyUrl: string;
  /** Hours until the token expires (24 today). Surfaced in the copy. */
  expiresInHours: number;
}

// ── Output ────────────────────────────────────────────────────────────────

export interface EmailVerificationOutput {
  subject: string;
  html: string;
  text: string;
}

// ── Render ────────────────────────────────────────────────────────────────

export function renderEmailVerificationEmail(
  input: EmailVerificationInput,
): EmailVerificationOutput {
  const subject = "Verify your Consultway account";

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
                  Confirm your email
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.user.name)},
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Thanks for registering with Consultway. To finish setting up your account, please confirm this email address by clicking the button below.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
                  <tr>
                    <td style="background:#3d2f1f; border-radius:6px;">
                      <a href="${escapeHtml(input.verifyUrl)}" style="display:inline-block; padding:12px 20px; font-size:15px; font-weight:500; color:#ffffff; text-decoration:none;">
                        Verify my email
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  Or paste this link into your browser:<br />
                  <a href="${escapeHtml(input.verifyUrl)}" style="color:#3d2f1f; word-break:break-all;">${escapeHtml(input.verifyUrl)}</a>
                </p>

                <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  This link expires in ${input.expiresInHours} hours. Didn't sign up? You can safely ignore this email.
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
    `Hi ${input.user.name},`,
    "",
    "Thanks for registering with Consultway. To finish setting up your account, please confirm this email address by visiting the link below.",
    "",
    input.verifyUrl,
    "",
    `This link expires in ${input.expiresInHours} hours. Didn't sign up? You can safely ignore this email.`,
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
