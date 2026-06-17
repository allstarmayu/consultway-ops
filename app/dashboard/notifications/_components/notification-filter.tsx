/**
 * All / Unread filter for the notifications feed. URL-driven (the Server
 * Component page reads `?filter=` and re-fetches) so the choice survives
 * refresh and is shareable — same convention as the other list filters.
 *
 * @module app/dashboard/notifications/_components/notification-filter
 */
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface NotificationFilterProps {
  filter: "all" | "unread";
}

const TABS = [
  { value: "all", label: "All", href: "/dashboard/notifications" },
  {
    value: "unread",
    label: "Unread",
    href: "/dashboard/notifications?filter=unread",
  },
] as const;

export function NotificationFilter({ filter }: NotificationFilterProps) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {TABS.map((tab) => {
        const isActive = filter === tab.value;
        return (
          <Link
            key={tab.value}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
