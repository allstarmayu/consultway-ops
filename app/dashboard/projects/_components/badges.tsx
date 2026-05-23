/**
 * Project status badge.
 *
 * Same visual language as `app/dashboard/tenders/_components/badges.tsx`
 * — one config object per status, palette-consistent with the Warm
 * Ambient theme. Kept in its own file (instead of folded into the
 * tenders badges file) so the projects module stays modularly clean —
 * adding a sixth status tomorrow is a one-file edit.
 *
 * @module app/dashboard/projects/_components/badges
 */
import {
  CheckCircle2,
  CircleDashed,
  PauseCircle,
  Play,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectStatus } from "@/lib/db/schema";

interface ProjectStatusStyle {
  /** Human-readable label. */
  label: string;
  /** Tailwind classes for the pill bg / text / border. */
  classes: string;
  /** Leading icon. */
  icon: LucideIcon;
}

/**
 * Per-status visual config. Mirrors the tender status badge styles for
 * familiarity:
 *   - planning  — muted (Sand-ish), dashed circle → "not yet started"
 *   - active    — primary terracotta, play icon → "in motion"
 *   - on_hold   — accent muted, pause → "temporarily paused"
 *   - completed — foreground/inverse, check-circle → "done well"
 *   - cancelled — destructive tones, X-circle → "terminated"
 */
const PROJECT_STATUS_STYLES: Record<ProjectStatus, ProjectStatusStyle> = {
  planning: {
    label: "Planning",
    classes: "bg-muted text-muted-foreground border-border",
    icon: CircleDashed,
  },
  active: {
    label: "Active",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: Play,
  },
  on_hold: {
    label: "On hold",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: PauseCircle,
  },
  completed: {
    label: "Completed",
    classes: "bg-foreground text-background border-transparent",
    icon: CheckCircle2,
  },
  cancelled: {
    label: "Cancelled",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
    icon: XCircle,
  },
};

export interface ProjectStatusBadgeProps {
  status: ProjectStatus;
  iconless?: boolean;
}

export function ProjectStatusBadge({
  status,
  iconless = false,
}: ProjectStatusBadgeProps) {
  const style = PROJECT_STATUS_STYLES[status];
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
      )}
    >
      {!iconless && <Icon className="h-3 w-3" aria-hidden />}
      {style.label}
    </span>
  );
}

/**
 * The full list of project status options. Exported so the filter bar
 * (which renders one Select option per status) doesn't have to
 * re-declare the same set.
 */
export const PROJECT_STATUS_OPTIONS: Array<{
  value: ProjectStatus;
  label: string;
}> = (
  Object.keys(PROJECT_STATUS_STYLES) as ProjectStatus[]
).map((value) => ({ value, label: PROJECT_STATUS_STYLES[value].label }));
