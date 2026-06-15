/**
 * User account-actions panel (client).
 *
 * Controls for a single user, role-gated:
 *   - **Admin**: deactivate / reactivate, and either resend the invite
 *     (if the account hasn't been accepted) or send a password-reset link
 *     (if it has).
 *   - **Staff**: resend the invite only — and only while the account is
 *     still pending. With nothing to do (an activated user), the panel
 *     doesn't render for staff.
 *
 * Each action runs the matching Server Action in a transition, toasts the
 * outcome, and `router.refresh()`es so the detail page re-renders. The
 * Server Actions re-check the role server-side (defence in depth).
 *
 * Self-guard: an admin can't deactivate their own account (the action also
 * enforces this server-side); the Deactivate control is hidden for self.
 *
 * @module app/dashboard/admin/users/[id]/_components/user-actions
 */
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserCheck, KeyRound, Send, Ban } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  resendInvite,
} from "@/lib/users/actions";
import type { UserRole } from "@/lib/db/schema";

export interface UserActionsProps {
  userId: string;
  isActive: boolean;
  /** True when the user was invited but hasn't set a password yet. */
  isPendingInvite: boolean;
  /** True when the viewing admin is this same user. */
  isSelf: boolean;
  /** Viewer's role. Staff get resend-invite only; the rest is admin-only. */
  viewerRole: UserRole;
}

export function UserActions({
  userId,
  isActive,
  isPendingInvite,
  isSelf,
  viewerRole,
}: UserActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const isAdmin = viewerRole === "admin";
  // Staff can only resend a pending invite. If there's nothing for them to
  // do (the account is already activated), don't render an empty panel.
  if (!isAdmin && !isPendingInvite) return null;

  function runSimple(
    action: (id: string) => Promise<{ ok: boolean; error?: string }>,
    successMsg: string,
  ) {
    startTransition(async () => {
      const result = await action(userId);
      if (!result.ok) {
        toast.error(result.error ?? "Something went wrong");
        return;
      }
      toast.success(successMsg);
      router.refresh();
    });
  }

  function runEmail(
    action: (
      id: string,
    ) => Promise<
      { ok: true; emailSent: boolean } | { ok: false; error: string }
    >,
    sentMsg: string,
    notSentMsg: string,
  ) {
    startTransition(async () => {
      const result = await action(userId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.emailSent) toast.success(sentMsg);
      else toast.warning(notSentMsg);
      router.refresh();
    });
  }

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-foreground">
        Account actions
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {isAdmin
          ? "Manage this user's access and credentials."
          : "Resend this user's invitation if they haven't set up their account."}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {/* Active-state toggle — admin only */}
        {isAdmin &&
          (isActive ? (
            !isSelf && (
              <ConfirmDialog
                trigger={
                  <Button
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                  >
                    <Ban className="h-4 w-4" aria-hidden />
                    Deactivate
                  </Button>
                }
                title="Deactivate this user?"
                description="They can't sign in again until you reactivate the account. Any session they already have stays valid until it expires. Their records and history are preserved."
                confirmLabel="Deactivate"
                confirmVariant="destructive"
                onConfirm={() => runSimple(deactivateUser, "User deactivated")}
                pending={isPending}
              />
            )
          ) : (
            <Button
              variant="outline"
              disabled={isPending}
              onClick={() => runSimple(reactivateUser, "User reactivated")}
            >
              <UserCheck className="h-4 w-4" aria-hidden />
              Reactivate
            </Button>
          ))}

        {/* Credential action: resend invite (admin + staff) OR, once the
            account is activated, send a password reset (admin only). */}
        {isPendingInvite ? (
          <Button
            variant="outline"
            disabled={isPending}
            onClick={() =>
              runEmail(
                resendInvite,
                "Invite resent",
                "User saved, but the invite email couldn't be sent. Check the email configuration.",
              )
            }
          >
            <Send className="h-4 w-4" aria-hidden />
            Resend invite
          </Button>
        ) : (
          isAdmin && (
            <ConfirmDialog
              trigger={
                <Button variant="outline">
                  <KeyRound className="h-4 w-4" aria-hidden />
                  Send password reset
                </Button>
              }
              title="Send a password reset link?"
              description="We'll email this user a secure link to choose a new password. Their current password keeps working until they use it."
              confirmLabel="Send reset link"
              onConfirm={() =>
                runEmail(
                  resetUserPassword,
                  "Password reset link sent",
                  "Couldn't send the reset email. Check the email configuration.",
                )
              }
              pending={isPending}
            />
          )
        )}
      </div>

      {isSelf && (
        <p className="mt-3 text-xs text-muted-foreground">
          This is your own account — you can&apos;t deactivate yourself.
        </p>
      )}
    </Card>
  );
}
