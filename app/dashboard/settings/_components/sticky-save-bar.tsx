/**
 * StickySaveBar — animated bottom bar that slides into view when a section
 * has unsaved changes.
 *
 * Sister to `components/forms/sticky-action-bar.tsx` but animated via
 * framer-motion so the bar feels like part of the page instead of a
 * static element that flickers on/off. Used across every Settings
 * section so the experience is consistent.
 *
 * Wraps `<AnimatePresence>` to mount/unmount the bar with a slide + fade.
 * The parent passes `isDirty` to control visibility and `onSave` /
 * `onCancel` for the actions.
 *
 * @module app/dashboard/settings/_components/sticky-save-bar
 */
"use client";

import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface StickySaveBarProps {
  /** Whether the form has unsaved changes — controls visibility. */
  isDirty: boolean;
  /** Whether a save is in flight — disables both buttons. */
  isSaving?: boolean;
  /** "Save" handler — passed straight to the primary button. */
  onSave: () => void;
  /** "Discard" handler — typically resets the form to its initial values. */
  onCancel: () => void;
  /** Optional left-side helper text. Default: "You have unsaved changes." */
  helper?: string;
}

export function StickySaveBar({
  isDirty,
  isSaving = false,
  onSave,
  onCancel,
  helper = "You have unsaved changes.",
}: StickySaveBarProps) {
  return (
    <AnimatePresence>
      {isDirty && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{
            type: "spring",
            stiffness: 320,
            damping: 30,
          }}
          className={cn(
            "pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4",
          )}
        >
          <div
            className={cn(
              "pointer-events-auto flex w-full max-w-xl items-center justify-between gap-4 rounded-full border border-border bg-card px-4 py-2 shadow-lg",
              "ring-1 ring-foreground/5",
            )}
          >
            <p className="truncate text-sm text-foreground/80">{helper}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onSave}
                disabled={isSaving}
              >
                {isSaving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
