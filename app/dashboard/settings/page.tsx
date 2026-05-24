/**
 * /dashboard/settings — user + organization preferences.
 *
 * Server Component. Reads the session once and hands typed props to the
 * (client) settings shell. The shell owns all interactive state (active
 * section, dirty flag, framer-motion transitions, theme picker).
 *
 * Sections rendered:
 *   - Profile         — full name, email, phone, role; persists to local
 *                       form state only this round (no DB write yet).
 *   - Appearance      — palette picker (6 options), motion + density
 *                       preferences. Theme change is live via next-themes.
 *   - Security        — password change + 2FA placeholder + sign-out-
 *                       everywhere action.
 *   - Notifications   — email preference toggles.
 *   - Organization    — admin / staff only. Org name, industry, address.
 *
 * Role gating: Company-role users get 4 sections (no Organization).
 * Admin/Staff get all 5.
 *
 * Auth: dashboard layout already redirects unauthenticated visitors; this
 * page is a belt-and-suspenders re-check that also gives us the typed
 * session for the shell.
 *
 * @module app/dashboard/settings/page
 */
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { getPreferences } from "@/lib/preferences/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { SettingsShell } from "./_components/settings-shell";

export const metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  // Fetch persisted preferences server-side so each section can hydrate
  // with the user's actual saved values (theme, notification toggles,
  // etc.) instead of hard-coded defaults. `getPreferences` returns the
  // defaults shape when no row exists yet — never a missing case.
  const prefs = await getPreferences();
  if (!prefs.ok) {
    // Only path that fails: unauthenticated. We already redirect above,
    // so this should be unreachable — but the type system doesn't know
    // that. Defensive bounce just in case.
    redirect("/login");
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Settings"
        subtitle="Manage your profile, appearance, and workspace preferences."
      />

      <SettingsShell
        userEmail={session.email}
        userRole={session.role}
        userId={session.userId}
        initialPreferences={prefs.preferences}
      />
    </div>
  );
}
