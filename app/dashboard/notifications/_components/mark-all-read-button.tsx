/**
 * "Mark all read" action (client). Flushes `markAllNotificationsRead`, toasts
 * the outcome, and `router.refresh()`es so the feed + sidebar badge update.
 *
 * @module app/dashboard/notifications/_components/mark-all-read-button
 */
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { markAllNotificationsRead } from "@/lib/notifications/actions";

export function MarkAllReadButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await markAllNotificationsRead();
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't update notifications");
        return;
      }
      toast.success("All notifications marked read");
      router.refresh();
    });
  }

  return (
    <Button variant="outline" onClick={handleClick} disabled={isPending}>
      <CheckCheck className="h-4 w-4" aria-hidden />
      {isPending ? "Marking..." : "Mark all read"}
    </Button>
  );
}
