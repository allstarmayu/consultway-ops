/**
 * ProfileSection — name / email / phone / role / avatar.
 *
 * Day 27: `fullName` is now real — wires to `lib/profile/actions.ts::
 * updateProfile`, which writes through to `users.name` and emits an
 * audit event. The other three fields (email, phone, jobTitle) stay
 * cosmetic this round:
 *   - email change needs a verification flow (verify-old + verify-new)
 *   - phone has no column on `users` yet (micro-migration deferred)
 *   - jobTitle is purely decorative, no persistence target yet
 * The form still accepts typing into all four so the layout doesn't
 * feel broken; only `fullName` is persisted on save.
 *
 * The avatar's initials are derived from the current `fullName` value
 * (falling back to the email localpart when blank), so renaming
 * yourself updates the avatar in real time before save.
 *
 * @module app/dashboard/settings/_components/profile-section
 */
"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Camera, Mail } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/forms/form-field";
import { updateProfile } from "@/lib/profile/actions";
import {
  buildStaleSessionRedirectUrl,
  isStaleSessionError,
} from "@/lib/auth/stale-session";
import type { UserRole } from "@/lib/db/schema";
import { SectionCard } from "./section-card";
import { StickySaveBar } from "./sticky-save-bar";

export interface ProfileSectionProps {
  userId: string;
  /** Persisted display name from `users.name`. */
  initialName: string;
  initialEmail: string;
  userRole: UserRole;
}

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  jobTitle: string;
}

const roleLabels: Record<UserRole, string> = {
  admin: "Administrator",
  staff: "Consultway Staff",
  company: "Registered Company",
};

export function ProfileSection({
  initialName,
  initialEmail,
  userRole,
}: ProfileSectionProps) {
  // `useState` for `initial` so we can advance the baseline after a
  // successful save (otherwise `isDirty` stays true forever even
  // after the name persists).
  const initialMemo = useMemo<FormState>(
    () => ({
      fullName: initialName,
      email: initialEmail,
      phone: "",
      jobTitle: "",
    }),
    [initialName, initialEmail],
  );
  const [initial, setInitial] = useState<FormState>(initialMemo);
  const [form, setForm] = useState<FormState>(initialMemo);
  const [isPending, startTransition] = useTransition();

  // Only the name actually persists — see the module docstring. The
  // other three fields are still tracked in local state so the form
  // feels live, but they don't gate the save indicator either.
  const isDirty = form.fullName !== initial.fullName;

  const initials = deriveInitials(form.fullName || initial.email);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    startTransition(async () => {
      const result = await updateProfile({ name: form.fullName });
      if (!result.ok) {
        toast.error("Couldn't save profile", {
          id: "profile-save-error",
          description: result.error,
        });
        // Stale-session: the JWT outlived the user row. Hard-nav to
        // the clear-session route so the bad cookie is deleted before
        // the browser lands on /login (otherwise proxy.ts bounces the
        // still-valid-looking cookie back to /dashboard).
        if (isStaleSessionError(result.error)) {
          window.location.assign(
            buildStaleSessionRedirectUrl("/dashboard/settings"),
          );
        }
        return;
      }
      // Advance the baseline so the save bar collapses and a follow-up
      // edit can be detected as a fresh dirty state.
      const nextInitial: FormState = { ...form, fullName: result.name };
      setInitial(nextInitial);
      setForm(nextInitial);
      // `id` deduplicates — saving twice in a row updates the existing
      // toast in place rather than stacking a second card behind it.
      toast.success("Profile updated", {
        id: "profile-saved",
        description: "Your name has been saved.",
      });
    });
  }

  function handleCancel() {
    setForm(initial);
  }

  return (
    <>
      <div className="space-y-6">
        <SectionCard
          id="section-heading-profile"
          title="Profile"
          description="How you appear across the workspace."
        >
          {/* Avatar row */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <Avatar size="lg" className="size-16">
                <AvatarFallback className="bg-accent/15 text-base font-semibold text-accent">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {form.fullName || "Unnamed user"}
                </p>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                  <span className="truncate">{form.email}</span>
                </p>
                <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                  {roleLabels[userRole]}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                // `id` deduplicates so repeated clicks refresh the same
                // toast in place instead of stacking a deck of identical
                // cards (which our taller redesigned toast reveals as
                // ghost rectangles peeking out from the back).
                toast.info("Avatar uploads coming soon", {
                  id: "avatar-uploads-soon",
                  description: "R2 photo uploads land in a later phase.",
                })
              }
            >
              <Camera className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Change photo
            </Button>
          </div>

          {/* Fields */}
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormField name="fullName" label="Full name">
              <Input
                value={form.fullName}
                onChange={(e) => update("fullName", e.target.value)}
                placeholder="e.g. Mayuresh Dongare"
                autoComplete="name"
              />
            </FormField>

            <FormField name="email" label="Email address">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                placeholder="you@consultway.in"
                autoComplete="email"
              />
            </FormField>

            <FormField name="phone" label="Phone number">
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+91 98765 43210"
                autoComplete="tel"
              />
            </FormField>

            <FormField name="jobTitle" label="Job title">
              <Input
                value={form.jobTitle}
                onChange={(e) => update("jobTitle", e.target.value)}
                placeholder="e.g. Project Manager"
                autoComplete="organization-title"
              />
            </FormField>
          </div>
        </SectionCard>

        <SectionCard
          title="Account"
          description="Read-only account metadata."
        >
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Role</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {roleLabels[userRole]}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sign-in email</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {initialEmail}
              </dd>
            </div>
          </dl>
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

/** Two-letter initials from a name like "Mayuresh Dongare" → "MD". */
function deriveInitials(input: string): string {
  const cleaned = input.trim();
  if (!cleaned) return "??";
  const localpart = cleaned.includes("@") ? cleaned.split("@")[0]! : cleaned;
  const parts = localpart
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return cleaned.slice(0, 2).toUpperCase();
  return parts.map((p) => p[0]!.toUpperCase()).join("");
}
