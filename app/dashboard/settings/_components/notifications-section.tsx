/**
 * NotificationsSection — email preference toggles, persisted to DB.
 *
 * Two grouped cards (digests + alerts) of switches. Local state is
 * hydrated from the persisted `user_preferences` row passed in by the
 * Settings shell. Save flushes the diff via `updatePreferences` and
 * toasts on success / error. A failed save rolls back the local state.
 *
 * @module app/dashboard/settings/_components/notifications-section
 */
"use client";

import { useMemo, useState, useTransition } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  FileWarning,
  Inbox,
  Megaphone,
  UserPlus,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { updatePreferences } from "@/lib/preferences/actions";
import {
  buildStaleSessionRedirectUrl,
  isStaleSessionError,
} from "@/lib/auth/stale-session";
import type { UserPreferences } from "@/lib/db/schema";
import { SectionCard } from "./section-card";
import { StickySaveBar } from "./sticky-save-bar";
import type { LucideIcon } from "lucide-react";

/** A single switch row's metadata. `id` matches a column on `userPreferences`. */
interface Pref {
  id: NotificationKey;
  label: string;
  description: string;
  icon: LucideIcon;
}

/** Subset of UserPreferences columns this section owns. */
type NotificationKey =
  | "weeklyDigest"
  | "monthlyReport"
  | "documentExpiry"
  | "tenderAlerts"
  | "assignmentAlerts"
  | "incidentAlerts";

type NotificationState = Record<NotificationKey, boolean>;

const DIGEST_PREFS: Pref[] = [
  {
    id: "weeklyDigest",
    label: "Weekly digest",
    description: "Monday morning summary of last week's activity.",
    icon: Inbox,
  },
  {
    id: "monthlyReport",
    label: "Monthly report",
    description: "First-of-month report covering the previous calendar month.",
    icon: CalendarClock,
  },
];

const ALERT_PREFS: Pref[] = [
  {
    id: "documentExpiry",
    label: "Document expiry",
    description: "Heads-up 30 / 14 / 7 days before a document expires.",
    icon: FileWarning,
  },
  {
    id: "tenderAlerts",
    label: "Tender alerts",
    description: "New tenders matching your sectors and eligibility.",
    icon: Megaphone,
  },
  {
    id: "assignmentAlerts",
    label: "Assignment alerts",
    description: "When you're assigned to a project or tender.",
    icon: UserPlus,
  },
  {
    id: "incidentAlerts",
    label: "Incident alerts",
    description: "Critical issues like failed payments or compliance flags.",
    icon: AlertTriangle,
  },
];

const ALL_KEYS: readonly NotificationKey[] = [
  "weeklyDigest",
  "monthlyReport",
  "documentExpiry",
  "tenderAlerts",
  "assignmentAlerts",
  "incidentAlerts",
] as const;

function fromPreferences(prefs: UserPreferences): NotificationState {
  return {
    weeklyDigest: prefs.weeklyDigest,
    monthlyReport: prefs.monthlyReport,
    documentExpiry: prefs.documentExpiry,
    tenderAlerts: prefs.tenderAlerts,
    assignmentAlerts: prefs.assignmentAlerts,
    incidentAlerts: prefs.incidentAlerts,
  };
}

export interface NotificationsSectionProps {
  initialPreferences: UserPreferences;
}

export function NotificationsSection({
  initialPreferences,
}: NotificationsSectionProps) {
  const initialFromProps = useMemo(
    () => fromPreferences(initialPreferences),
    [initialPreferences],
  );

  // We track an "initial" snapshot in state too so a successful save
  // can mark the form as clean by updating it. Going back to the
  // server-passed value would clobber unsaved changes during refetch.
  const [initial, setInitial] = useState<NotificationState>(initialFromProps);
  const [state, setState] = useState<NotificationState>(initialFromProps);
  const [isPending, startTransition] = useTransition();

  const isDirty = ALL_KEYS.some((k) => initial[k] !== state[k]);

  function handleSave() {
    // Build a minimal patch — only the keys the user actually changed.
    const patch: Partial<NotificationState> = {};
    for (const k of ALL_KEYS) {
      if (initial[k] !== state[k]) patch[k] = state[k];
    }

    startTransition(async () => {
      const result = await updatePreferences(patch);
      if (!result.ok) {
        toast.error("Couldn't save preferences", {
          id: "notifications-save-error",
          description: result.error,
        });
        if (isStaleSessionError(result.error)) {
          window.location.assign(
            buildStaleSessionRedirectUrl("/dashboard/settings"),
          );
        }
        return;
      }
      setInitial(fromPreferences(result.preferences));
      toast.success("Notification preferences saved", {
        id: "notifications-saved",
      });
    });
  }

  function handleCancel() {
    setState({ ...initial });
  }

  return (
    <>
      <div className="space-y-6">
        <SectionCard
          id="section-heading-notifications"
          title="Email digests"
          description="Periodic summaries delivered to your inbox."
        >
          <PrefList
            prefs={DIGEST_PREFS}
            state={state}
            onToggle={(id, v) =>
              setState((prev) => ({ ...prev, [id]: v }))
            }
          />
        </SectionCard>

        <SectionCard
          title="Real-time alerts"
          description="Triggered the moment something needs your attention."
        >
          <PrefList
            prefs={ALERT_PREFS}
            state={state}
            onToggle={(id, v) =>
              setState((prev) => ({ ...prev, [id]: v }))
            }
          />
        </SectionCard>
      </div>

      <StickySaveBar
        isDirty={isDirty}
        isSaving={isPending}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </>
  );
}

// ── Local sub-component ────────────────────────────────────────────────────

interface PrefListProps {
  prefs: Pref[];
  state: NotificationState;
  onToggle: (id: NotificationKey, value: boolean) => void;
}

function PrefList({ prefs, state, onToggle }: PrefListProps) {
  return (
    <ul className="divide-y divide-border">
      {prefs.map((p, idx) => {
        const Icon = p.icon;
        return (
          <motion.li
            key={p.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.04, duration: 0.25 }}
            className="flex items-start gap-4 py-4 first:pt-0 last:pb-0"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/70">
              <Icon className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <Label
                htmlFor={`pref-${p.id}`}
                className="text-sm font-medium text-foreground"
              >
                {p.label}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {p.description}
              </p>
            </div>
            <Switch
              id={`pref-${p.id}`}
              checked={state[p.id]}
              onCheckedChange={(v) => onToggle(p.id, v)}
            />
          </motion.li>
        );
      })}
    </ul>
  );
}
