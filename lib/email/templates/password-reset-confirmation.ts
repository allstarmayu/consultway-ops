/**
 * Password reset confirmation email.
 *
 * Sent AFTER a successful password reset, purely informational. No CTA
 * button — the body says "if this wasn't you, contact ops". Confirmation
 * emails on password change are a standard security pattern; a
 * compromised account that just had its password rotated is exactly the
 * one case where you WANT to alarm the legitimate owner.
 *
 * @module lib/email/templates/password-reset-confirmation
 */

export interface PasswordResetConfirmationInput {
  user: {
    name: string;
    email: string;
  };
  /** Email/URL prospects should reach if the reset wasn't them. */
  supportEmail: string;
}

export interface PasswordResetConfirmationOutput {
  subject: string;
  html: string;
  text: string;
}

export function renderPasswordResetConfirmationEmail(
  input: PasswordResetConfirmationInput,
): PasswordResetConfirmationOutput {
  const subject = "Your Consultway password was changed";

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
                  Your password was changed
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.user.name)},
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  The password for your Consultway account was just changed. If you made this change, no further action is needed.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0; background:#fef7ec; border-left:3px solid #d97706; border-radius:6px; padding:16px;">
                  <tr>
                    <td style="font-size:14px; line-height:1.6; color:#7a4a09;">
                      If this wasn't you, please contact <a href="mailto:${escapeHtml(input.supportEmail)}" style="color:#7a4a09; font-weight:500;">${escapeHtml(input.supportEmail)}</a> immediately. Your account may be compromised.
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  This is an automated notice. We send it on every successful password change so you can detect unauthorised access early.
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
    "The password for your Consultway account was just changed. If you made this change, no further action is needed.",
    "",
    `If this wasn't you, please contact ${input.supportEmail} immediately. Your account may be compromised.`,
    "",
    "This is an automated notice. We send it on every successful password change so you can detect unauthorised access early.",
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
