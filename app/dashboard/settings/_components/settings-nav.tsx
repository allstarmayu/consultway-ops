/**
 * SettingsNav — left-rail navigation for /dashboard/settings.
 *
 * Renders one button per section with the active item highlighted via a
 * framer-motion `layoutId` pill that morphs between positions when the
 * user clicks a different section. The morphing pill is what gives the
 * nav its "modern" feel — no transform jank, just a smooth shared
 * layout transition.
 *
 * On large screens the nav is a vertical stack (sticky positioning is
 * applied by the parent). On small screens it falls back to a
 * horizontally-scrollable row so the section headers stay reachable
 * without growing the page height.
 *
 * @module app/dashboard/settings/_components/settings-nav
 */
"use client";

import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface SettingsNavProps {
  items: SettingsNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function SettingsNav({ items, activeId, onSelect }: SettingsNavProps) {
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        // Mobile: horizontal scroll row. Large: vertical stack.
        "flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0",
      )}
    >
      {items.map((item) => {
        const isActive = item.id === activeId;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(item.id)}
            className={cn(
              "group relative flex shrink-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive
                ? "text-accent-foreground"
                : "text-foreground/70 hover:bg-muted hover:text-foreground",
            )}
          >
            {/* Active pill — uses framer-motion's shared layoutId so it
                slides between buttons as the active section changes. */}
            {isActive && (
              <motion.span
                layoutId="settings-nav-pill"
                className="absolute inset-0 -z-0 rounded-lg bg-accent"
                transition={{
                  type: "spring",
                  stiffness: 380,
                  damping: 30,
                  mass: 0.8,
                }}
                aria-hidden
              />
            )}

            {/* Icon + label — z-10 keeps them above the animated pill. */}
            <Icon
              className={cn(
                "relative z-10 mt-0.5 h-4 w-4 shrink-0",
                isActive ? "text-accent-foreground" : "text-foreground/50",
              )}
              aria-hidden
            />
            <div className="relative z-10 min-w-0">
              <p className="font-medium leading-tight">{item.label}</p>
              <p
                className={cn(
                  "mt-0.5 hidden text-xs leading-tight lg:block",
                  isActive
                    ? "text-accent-foreground/80"
                    : "text-muted-foreground",
                )}
              >
                {item.description}
              </p>
            </div>
          </button>
        );
      })}
    </nav>
  );
}
