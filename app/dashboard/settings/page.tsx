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
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import { buildStaleSessionRedirectUrl } from "@/lib/auth/stale-session";
import { getPreferences } from "@/lib/preferences/actions";
import { getAvatarDisplayUrl } from "@/lib/avatars/server";
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
    // Two paths reach here: (1) unauthenticated (already redirected
    // above, defensive bounce), and (2) stale-session — the JWT cookie
    // is valid but the user row it points at no longer exists (e.g.
    // local DB was reseeded). Going to `/login` directly is wrong for
    // case 2: `proxy.ts` would see a still-valid cookie and bounce the
    // user back to `/dashboard`. Route through `/auth/clear-session`,
    // which deletes the cookie first — `proxy.ts` then sees a truly
    // unauthenticated user and lets them reach `/login` for real.
    redirect(buildStaleSessionRedirectUrl("/dashboard/settings"));
  }

  // Read the user's persisted profile fields so the Profile section
  // hydrates with current values instead of blank. We don't need to
  // defend against missing here — `getPreferences` already ran the
  // stale-session guard above, so the row exists.
  const [userRow] = await db
    .select({
      name: users.name,
      phone: users.phone,
      jobTitle: users.jobTitle,
      avatarKey: users.avatarKey,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const initialName = userRow?.name ?? "";
  const initialPhone = userRow?.phone ?? null;
  const initialJobTitle = userRow?.jobTitle ?? null;

  // Mint a presigned GET URL for the avatar, if one is set. Returns
  // null on R2 sign failure (logged + falls back to initials in the
  // Avatar component) — never throws.
  const initialAvatarUrl = await getAvatarDisplayUrl(
    userRow?.avatarKey ?? null,
  );

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
        initialName={initialName}
        initialPhone={initialPhone}
        initialJobTitle={initialJobTitle}
        initialAvatarUrl={initialAvatarUrl}
        initialHasAvatar={Boolean(userRow?.avatarKey)}
        initialPreferences={prefs.preferences}
      />
    </div>
  );
}
