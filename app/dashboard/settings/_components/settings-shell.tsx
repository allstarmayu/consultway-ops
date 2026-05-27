/**
 * SettingsShell — the interactive surface for /dashboard/settings.
 *
 * Owns:
 *   - Active section state (default: "profile").
 *   - Section list filtering — Company-role users don't see Organization.
 *   - The framer-motion <AnimatePresence> that cross-fades sections.
 *
 * Layout: left-rail nav (sticky on lg+) + right content column. On mobile
 * the nav stacks above the content. Each section component is fully
 * self-contained — it owns its own form state and "Save" handlers — which
 * keeps the shell free of section-specific knowledge and makes adding a
 * new section a one-line change to the `SECTIONS` array.
 *
 * @module app/dashboard/settings/_components/settings-shell
 */
"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell,
  Building2,
  Palette,
  Shield,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";
import type { UserPreferences, UserRole } from "@/lib/db/schema";
import { SettingsNav, type SettingsNavItem } from "./settings-nav";
import { ProfileSection } from "./profile-section";
import { AppearanceSection } from "./appearance-section";
import { SecuritySection } from "./security-section";
import { NotificationsSection } from "./notifications-section";
import { OrganizationSection } from "./organization-section";

// ── Section catalog ─────────────────────────────────────────────────────────

type SectionId =
  | "profile"
  | "appearance"
  | "security"
  | "notifications"
  | "organization";

interface SectionDef {
  id: SectionId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** If true, only Admin + Staff see this section. */
  internalOnly?: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    id: "profile",
    label: "Profile",
    description: "Your personal information.",
    icon: UserCircle2,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, density, and motion.",
    icon: Palette,
  },
  {
    id: "security",
    label: "Security",
    description: "Password and sessions.",
    icon: Shield,
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Email preferences.",
    icon: Bell,
  },
  {
    id: "organization",
    label: "Organization",
    description: "Workspace details.",
    icon: Building2,
    internalOnly: true,
  },
];

// ── Props ───────────────────────────────────────────────────────────────────

export interface SettingsShellProps {
  userId: string;
  userEmail: string;
  userRole: UserRole;
  /**
   * Persisted display name from `users.name`. Hydrates the Profile
   * section's form so the user sees their current name on first
   * paint instead of an empty field.
   */
  initialName: string;
  /**
   * Persisted phone from `users.phone`. Nullable — the column is
   * optional and many users will have never set it. The form coerces
   * null ↔ empty string at the input boundary.
   */
  initialPhone: string | null;
  /**
   * Persisted job title from `users.jobTitle`. Same shape as phone —
   * nullable, free text, no downstream effect today.
   */
  initialJobTitle: string | null;
  /**
   * Presigned GET URL for the user's avatar, or null when no avatar
   * is set (or when R2 sign failed). Minted server-side via
   * `getAvatarDisplayUrl` — Profile section just renders it; it
   * doesn't know about the underlying R2 key.
   */
  initialAvatarUrl: string | null;
  /**
   * Whether `users.avatar_key` is set. The Profile section uses this
   * to decide whether to show the "Remove" link — distinct from
   * `initialAvatarUrl != null` because a sign failure produces null
   * URL but the column is still populated (and a Remove call would
   * still want to clear it).
   */
  initialHasAvatar: boolean;
  /**
   * Persisted preferences row from `getPreferences()`. Sections hydrate
   * their initial form state from this, so a refresh shows what the user
   * actually has saved.
   */
  initialPreferences: UserPreferences;
}

// ── Component ───────────────────────────────────────────────────────────────

export function SettingsShell({
  userId,
  userEmail,
  userRole,
  initialName,
  initialPhone,
  initialJobTitle,
  initialAvatarUrl,
  initialHasAvatar,
  initialPreferences,
}: SettingsShellProps) {
  const visibleSections = useMemo(
    () =>
      SECTIONS.filter(
        (s) => !s.internalOnly || userRole === "admin" || userRole === "staff",
      ),
    [userRole],
  );

  const [activeId, setActiveId] = useState<SectionId>("profile");
  const activeSection =
    visibleSections.find((s) => s.id === activeId) ?? visibleSections[0]!;

  const navItems: SettingsNavItem[] = visibleSections.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    icon: s.icon,
  }));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10">
      {/* Left rail */}
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <SettingsNav
          items={navItems}
          activeId={activeId}
          onSelect={(id) => setActiveId(id as SectionId)}
        />
      </aside>

      {/* Right column — animated section switcher */}
      <div className="min-w-0">
        <AnimatePresence mode="wait">
          <motion.section
            key={activeSection.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{
              duration: 0.28,
              ease: [0.16, 1, 0.3, 1],
            }}
            aria-labelledby={`section-heading-${activeSection.id}`}
          >
            {activeSection.id === "profile" && (
              <ProfileSection
                userId={userId}
                initialName={initialName}
                initialPhone={initialPhone}
                initialJobTitle={initialJobTitle}
                initialAvatarUrl={initialAvatarUrl}
                initialHasAvatar={initialHasAvatar}
                initialEmail={userEmail}
                userRole={userRole}
              />
            )}
            {activeSection.id === "appearance" && (
              <AppearanceSection initialPreferences={initialPreferences} />
            )}
            {activeSection.id === "security" && <SecuritySection />}
            {activeSection.id === "notifications" && (
              <NotificationsSection initialPreferences={initialPreferences} />
            )}
            {activeSection.id === "organization" && <OrganizationSection />}
          </motion.section>
        </AnimatePresence>
      </div>
    </div>
  );
}
