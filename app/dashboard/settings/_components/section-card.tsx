/**
 * SectionCard — shared chrome for every Settings section.
 *
 * One card with a title + description header and a content body. Used so
 * every section looks identical from the outside; each section's only job
 * is the form inside.
 *
 * Picks up `animate-fade-up` (defined in app/globals.css) so it fades in
 * the first time it's mounted — pairs with the framer-motion section
 * transition in `settings-shell.tsx` to make the swap feel intentional.
 *
 * @module app/dashboard/settings/_components/section-card
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionCardProps {
  id?: string;
  title: string;
  description?: string;
  /** Optional right-aligned slot (e.g. a status badge). */
  headerAside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionCard({
  id,
  title,
  description,
  headerAside,
  children,
  className,
}: SectionCardProps) {
  return (
    <div
      className={cn(
        "animate-fade-up overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
        <div className="min-w-0">
          <h2
            id={id}
            className="text-lg font-semibold leading-tight text-foreground"
          >
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {headerAside && <div className="shrink-0">{headerAside}</div>}
      </header>
      <div className="px-6 py-6">{children}</div>
    </div>
  );
}
