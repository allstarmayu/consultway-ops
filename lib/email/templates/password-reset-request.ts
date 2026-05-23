/**
 * Password reset request email.
 *
 * Sent when a user submits the /forgot-password form for an email that
 * matches an existing account. Same shape as `email-verification.ts` —
 * pure render function, inline-styled HTML, plain-text fallback.
 *
 * @module lib/email/templates/password-reset-request
 */

export interface PasswordResetRequestInput {
  user: {
    name: string;
    email: string;
  };
  /** Fully-qualified `/reset-password?token=<raw>` URL. */
  resetUrl: string;
  /** Minutes until the token expires (60 today). Surfaced in the copy. */
  expiresInMinutes: number;
}

export interface PasswordResetRequestOutput {
  subject: string;
  html: string;
  text: string;
}

export function renderPasswordResetRequestEmail(
  input: PasswordResetRequestInput,
): PasswordResetRequestOutput {
  const subject = "Reset your Consultway password";

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
                  Reset your password
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.user.name)},
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  We received a request to reset the password for your Consultway account. Click the button below to choose a new one.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
                  <tr>
                    <td style="background:#3d2f1f; border-radius:6px;">
                      <a href="${escapeHtml(input.resetUrl)}" style="display:inline-block; padding:12px 20px; font-size:15px; font-weight:500; color:#ffffff; text-decoration:none;">
                        Choose a new password
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  Or paste this link into your browser:<br />
                  <a href="${escapeHtml(input.resetUrl)}" style="color:#3d2f1f; word-break:break-all;">${escapeHtml(input.resetUrl)}</a>
                </p>

                <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  This link expires in ${input.expiresInMinutes} minutes. Didn't request this? You can safely ignore this email — your password is unchanged.
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
    "We received a request to reset the password for your Consultway account. Use the link below to choose a new one.",
    "",
    input.resetUrl,
    "",
    `This link expires in ${input.expiresInMinutes} minutes. Didn't request this? You can safely ignore this email — your password is unchanged.`,
    "",
    "-- Consultway Infotech",
  ].join("\n");

  return { subject, html, text };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
