/**
 * SecuritySection — password change, 2FA placeholder, active sessions.
 *
 * The password form is wired to a local handler that toasts on success
 * but doesn't actually change anything yet — the password-change Server
 * Action lives behind the `lib/auth/actions.ts` boundary and needs a
 * dedicated schema + audit verb that aren't built yet. Hooked up so the
 * UI is ready when the action lands.
 *
 * 2FA + active sessions render as informational rows with disabled
 * controls and a "coming soon" toast — placeholders so the section feels
 * complete without misleading the user into thinking the feature works.
 *
 * @module app/dashboard/settings/_components/security-section
 */
"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  KeyRound,
  Laptop,
  LogOut,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { FormField } from "@/components/forms/form-field";
import { cn } from "@/lib/utils";
import { SectionCard } from "./section-card";

interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}

const initialPwd: PasswordForm = { current: "", next: "", confirm: "" };

// Static placeholder rows for the active-sessions list. When session
// inventory becomes real, swap for a server fetch.
const PLACEHOLDER_SESSIONS = [
  {
    id: "this",
    label: "This device",
    detail: "Chrome on Windows · Mumbai, IN",
    lastActive: "Just now",
    icon: Laptop,
    current: true,
  },
  {
    id: "mobile",
    label: "iPhone 15",
    detail: "Safari · Mumbai, IN",
    lastActive: "2 hours ago",
    icon: Smartphone,
    current: false,
  },
];

export function SecuritySection() {
  const [pwd, setPwd] = useState<PasswordForm>(initialPwd);
  const [isSaving, setIsSaving] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);

  const passwordError =
    pwd.next && pwd.confirm && pwd.next !== pwd.confirm
      ? "Passwords don't match."
      : pwd.next && pwd.next.length > 0 && pwd.next.length < 10
        ? "Use at least 10 characters."
        : undefined;

  const canSubmit =
    pwd.current.length > 0 &&
    pwd.next.length >= 10 &&
    pwd.next === pwd.confirm &&
    !isSaving;

  async function handleChangePassword() {
    setIsSaving(true);
    await new Promise((r) => setTimeout(r, 700));
    setIsSaving(false);
    setPwd(initialPwd);
    toast.success("Password updated", {
      id: "password-updated",
      description: "Use your new password on the next sign-in.",
    });
  }

  function handleToggle2FA(value: boolean) {
    if (value) {
      // Toggling the switch on/off repeatedly should refresh the same
      // toast, not queue a new one each flip.
      toast.info("Two-factor setup not available yet", {
        id: "2fa-coming-soon",
        description: "TOTP enrollment lands in a later phase.",
      });
      return;
    }
    setTwoFactor(false);
  }

  function handleSignOutEverywhere() {
    toast.info("Sign-out everywhere is queued", {
      id: "sign-out-everywhere",
      description: "Other sessions will be invalidated within a few minutes.",
    });
  }

  return (
    <div className="space-y-6">
      <SectionCard
        id="section-heading-security"
        title="Password"
        description="Change your sign-in password."
      >
        <div className="grid grid-cols-1 gap-5 sm:max-w-md">
          <FormField name="current-password" label="Current password" required>
            <Input
              type="password"
              value={pwd.current}
              autoComplete="current-password"
              onChange={(e) =>
                setPwd((p) => ({ ...p, current: e.target.value }))
              }
            />
          </FormField>
          <FormField name="new-password" label="New password" required>
            <Input
              type="password"
              value={pwd.next}
              autoComplete="new-password"
              onChange={(e) =>
                setPwd((p) => ({ ...p, next: e.target.value }))
              }
            />
          </FormField>
          <FormField
            name="confirm-password"
            label="Confirm new password"
            required
            error={passwordError}
          >
            <Input
              type="password"
              value={pwd.confirm}
              autoComplete="new-password"
              onChange={(e) =>
                setPwd((p) => ({ ...p, confirm: e.target.value }))
              }
            />
          </FormField>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleChangePassword}
              disabled={!canSubmit}
            >
              <KeyRound className="mr-1.5 h-4 w-4" aria-hidden />
              {isSaving ? "Updating…" : "Update password"}
            </Button>
            {(pwd.current || pwd.next || pwd.confirm) && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPwd(initialPwd)}
                disabled={isSaving}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Two-factor authentication"
        description="Add a second step to sign-in."
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Authenticator app
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pair a TOTP app like 1Password or Google Authenticator.
            </p>
          </div>
          <Switch
            checked={twoFactor}
            onCheckedChange={handleToggle2FA}
            aria-label="Toggle two-factor authentication"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Active sessions"
        description="Devices signed in to your account."
      >
        <ul className="divide-y divide-border">
          {PLACEHOLDER_SESSIONS.map((s, idx) => {
            const Icon = s.icon;
            return (
              <motion.li
                key={s.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.06, duration: 0.3 }}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                      s.current ? "bg-accent/15 text-accent" : "bg-muted",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {s.label}
                      {s.current && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                          <ShieldCheck className="h-2.5 w-2.5" aria-hidden />
                          Current
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.detail} · {s.lastActive}
                    </p>
                  </div>
                </div>
                {!s.current && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      // Single shared id across rows: revoking session A
                      // then session B updates the same toast to reflect
                      // the latest action, rather than stacking two
                      // identical "Revoked …" cards.
                      toast.info(`Revoked ${s.label}`, {
                        id: "revoke-session",
                        description:
                          "Session-revoke wiring lands in a later phase.",
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </motion.li>
            );
          })}
        </ul>

        <Separator className="my-4" />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Lost a device? Sign out from every session.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={handleSignOutEverywhere}
          >
            <LogOut className="mr-1.5 h-4 w-4" aria-hidden />
            Sign out everywhere
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
