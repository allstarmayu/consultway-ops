/**
 * ProfileSection — name / email / phone / role / avatar.
 *
 * Local form state only this round (no DB write). The mock save handler
 * returns success after a short delay so the sticky save bar's animation
 * is testable without a backend dep. When the `users` table grows
 * `displayName` / `phone` columns, swap the mock for a real Server Action
 * and remove the `await sleep(...)` line.
 *
 * The avatar's initials are derived from the email's localpart — easy
 * to upgrade later when we add `users.displayName`.
 *
 * @module app/dashboard/settings/_components/profile-section
 */
"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Camera, Mail } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/forms/form-field";
import type { UserRole } from "@/lib/db/schema";
import { SectionCard } from "./section-card";
import { StickySaveBar } from "./sticky-save-bar";

export interface ProfileSectionProps {
  userId: string;
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
  initialEmail,
  userRole,
}: ProfileSectionProps) {
  const initial = useMemo<FormState>(
    () => ({
      fullName: "",
      email: initialEmail,
      phone: "",
      jobTitle: "",
    }),
    [initialEmail],
  );

  const [form, setForm] = useState<FormState>(initial);
  const [isSaving, setIsSaving] = useState(false);

  const isDirty =
    form.fullName !== initial.fullName ||
    form.email !== initial.email ||
    form.phone !== initial.phone ||
    form.jobTitle !== initial.jobTitle;

  const initials = deriveInitials(form.fullName || initial.email);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setIsSaving(true);
    // Stub: persistence pending — see <notes> in the PR description.
    await new Promise((r) => setTimeout(r, 600));
    setIsSaving(false);
    // `id` deduplicates — saving twice in a row updates the existing
    // toast in place rather than stacking a second card behind it.
    toast.success("Profile updated", {
      id: "profile-saved",
      description: "Your changes have been saved.",
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
        isSaving={isSaving}
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
