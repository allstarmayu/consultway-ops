/**
 * Admin user-invite email.
 *
 * Sent when an admin creates a user via the user-management UI
 * (lib/users/actions.ts::createUser). The recipient clicks the link to
 * choose their own password and activate the account (acceptInvite). Same
 * shape as `password-reset-request.ts` — pure render function, inline-styled
 * HTML, plain-text fallback, warm-ambient palette values copied verbatim.
 *
 * @module lib/email/templates/user-invite
 */

export interface UserInviteInput {
  user: {
    name: string;
    email: string;
  };
  /** Fully-qualified `/set-password?token=<raw>` URL. */
  inviteUrl: string;
  /** Who sent the invite (email or name). Surfaced in the copy for trust. */
  inviterName: string;
  /** Hours until the invite token expires (72 today). Surfaced in the copy. */
  expiresInHours: number;
}

export interface UserInviteOutput {
  subject: string;
  html: string;
  text: string;
}

export function renderUserInviteEmail(input: UserInviteInput): UserInviteOutput {
  const subject = "You've been invited to Consultway";

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
                  Welcome to Consultway
                </h1>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  Hi ${escapeHtml(input.user.name)},
                </p>
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
                  ${escapeHtml(input.inviterName)} has invited you to the Consultway Operations Platform. Click the button below to set your password and activate your account.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
                  <tr>
                    <td style="background:#3d2f1f; border-radius:6px;">
                      <a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block; padding:12px 20px; font-size:15px; font-weight:500; color:#ffffff; text-decoration:none;">
                        Set your password
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  Or paste this link into your browser:<br />
                  <a href="${escapeHtml(input.inviteUrl)}" style="color:#3d2f1f; word-break:break-all;">${escapeHtml(input.inviteUrl)}</a>
                </p>

                <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#6b5b4a;">
                  This invitation expires in ${input.expiresInHours} hours. If you weren't expecting it, you can safely ignore this email.
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
    `${input.inviterName} has invited you to the Consultway Operations Platform. Use the link below to set your password and activate your account.`,
    "",
    input.inviteUrl,
    "",
    `This invitation expires in ${input.expiresInHours} hours. If you weren't expecting it, you can safely ignore this email.`,
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
