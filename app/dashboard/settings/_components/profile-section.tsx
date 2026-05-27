/**
 * ProfileSection — name / email / phone / role / avatar.
 *
 * Day 28: `fullName`, `phone`, and `jobTitle` all persist now — the
 * action writes through to `users.name` / `users.phone` /
 * `users.jobTitle` and emits a SCOPED audit event (only the columns
 * that actually changed appear in before/after). Email stays cosmetic
 * this round; changing the primary identifier needs a verify-old +
 * verify-new flow and a separate session.
 *
 * The avatar's initials are derived from the current `fullName` value
 * (falling back to the email localpart when blank), so renaming
 * yourself updates the avatar in real time before save.
 *
 * The save bar lights up when ANY of the three persisted fields differ
 * from the baseline — so a user can change just their job title, hit
 * save, and the action will skip the unchanged columns server-side.
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
  /** Persisted phone from `users.phone`. Null when never set. */
  initialPhone: string | null;
  /** Persisted job title from `users.jobTitle`. Null when never set. */
  initialJobTitle: string | null;
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
  initialPhone,
  initialJobTitle,
  initialEmail,
  userRole,
}: ProfileSectionProps) {
  // Coerce null → empty string at the input boundary — `<Input value>`
  // treats both the same visually, but using "" keeps React from
  // flipping the input between controlled and uncontrolled.
  const initialMemo = useMemo<FormState>(
    () => ({
      fullName: initialName,
      email: initialEmail,
      phone: initialPhone ?? "",
      jobTitle: initialJobTitle ?? "",
    }),
    [initialName, initialPhone, initialJobTitle, initialEmail],
  );
  // `useState` for `initial` so we can advance the baseline after a
  // successful save (otherwise `isDirty` stays true forever even
  // after the values persist).
  const [initial, setInitial] = useState<FormState>(initialMemo);
  const [form, setForm] = useState<FormState>(initialMemo);
  const [isPending, startTransition] = useTransition();

  // Save bar lights up when ANY of the three persisted fields differ
  // from baseline. Email isn't included — it stays cosmetic this round.
  const isDirty =
    form.fullName !== initial.fullName ||
    form.phone !== initial.phone ||
    form.jobTitle !== initial.jobTitle;

  const initials = deriveInitials(form.fullName || initial.email);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    startTransition(async () => {
      // Trim + null-coerce at the call site so the action receives the
      // canonical shape the schema expects. Empty string → null both
      // here and on the server (defence in depth — server still
      // coerces, but sending null reads more clearly in network logs).
      const trimmedPhone = form.phone.trim();
      const trimmedJobTitle = form.jobTitle.trim();
      const result = await updateProfile({
        name: form.fullName,
        phone: trimmedPhone.length === 0 ? null : trimmedPhone,
        jobTitle: trimmedJobTitle.length === 0 ? null : trimmedJobTitle,
      });
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
      // edit can be detected as a fresh dirty state. The action returns
      // the persisted shape, including the null-coerced phone /
      // jobTitle — flatten to "" for the form's controlled inputs.
      const nextInitial: FormState = {
        fullName: result.name,
        email: form.email,
        phone: result.phone ?? "",
        jobTitle: result.jobTitle ?? "",
      };
      setInitial(nextInitial);
      setForm(nextInitial);
      // `id` deduplicates — saving twice in a row updates the existing
      // toast in place rather than stacking a second card behind it.
      toast.success("Profile updated", {
        id: "profile-saved",
        description: "Your changes have been saved.",
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
                maxLength={32}
              />
            </FormField>

            <FormField name="jobTitle" label="Job title">
              <Input
                value={form.jobTitle}
                onChange={(e) => update("jobTitle", e.target.value)}
                placeholder="e.g. Project Manager"
                autoComplete="organization-title"
                maxLength={120}
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
