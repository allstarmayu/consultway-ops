/**
 * ProfileSection — name / email / phone / job title / avatar.
 *
 * Day 28: name + phone + jobTitle persist through `updateProfile`.
 * Day 29: avatar uploads via R2 — Change photo opens the native file
 *   picker, an `initiateAvatarUpload` action mints a presigned PUT URL,
 *   the browser uploads bytes directly to R2, `confirmAvatarUpload`
 *   flips `users.avatar_key`, and `router.refresh()` re-renders so
 *   the new presigned GET URL flows through SSR.
 *
 * The avatar uses Radix's `<AvatarImage>` (plain `<img>` under the
 * hood) with a presigned GET URL minted server-side — so no
 * `next/image` remotePatterns config is needed.
 *
 * Email stays cosmetic this round; changing the primary identifier
 * needs a verify-old + verify-new flow (deferred to a security-themed
 * session).
 *
 * @module app/dashboard/settings/_components/profile-section
 */
"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Mail, Trash2 } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/forms/form-field";
import { updateProfile } from "@/lib/profile/actions";
import {
  confirmAvatarUpload,
  deleteAvatar,
  initiateAvatarUpload,
} from "@/lib/avatars/actions";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  MAX_AVATAR_SIZE_BYTES,
} from "@/lib/avatars/schemas";
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
  /**
   * Presigned GET URL for the user's avatar, or null. The Avatar
   * primitive renders `<img src={url} />` when present, falls back to
   * initials otherwise.
   */
  initialAvatarUrl: string | null;
  /**
   * Whether `users.avatar_key` is set. Distinct from
   * `initialAvatarUrl != null` because a sign failure produces null
   * URL but the column is still populated. Drives whether the
   * "Remove photo" link is shown.
   */
  initialHasAvatar: boolean;
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

/** Native picker `accept` attribute derived from the schema's allow-list. */
const AVATAR_ACCEPT_ATTR = ALLOWED_AVATAR_MIME_TYPES.join(",");

export function ProfileSection({
  initialName,
  initialPhone,
  initialJobTitle,
  initialAvatarUrl,
  initialHasAvatar,
  initialEmail,
  userRole,
}: ProfileSectionProps) {
  const router = useRouter();

  // ── Text-field form state (name, phone, jobTitle) ─────────────────────
  const initialMemo = useMemo<FormState>(
    () => ({
      fullName: initialName,
      email: initialEmail,
      phone: initialPhone ?? "",
      jobTitle: initialJobTitle ?? "",
    }),
    [initialName, initialPhone, initialJobTitle, initialEmail],
  );
  const [initial, setInitial] = useState<FormState>(initialMemo);
  const [form, setForm] = useState<FormState>(initialMemo);
  const [isSavingFields, startSaveTransition] = useTransition();

  // ── Avatar state ──────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isDeletingAvatar, startDeleteAvatarTransition] = useTransition();

  // Save bar lights up when ANY of the three persisted fields differ
  // from baseline. Email isn't included — it stays cosmetic this round.
  // Avatar isn't included either — that flow has its own progress UI
  // (the spinner on the Change photo button) and saves immediately
  // when a file is picked, no save-bar gesture required.
  const isDirty =
    form.fullName !== initial.fullName ||
    form.phone !== initial.phone ||
    form.jobTitle !== initial.jobTitle;

  const initials = deriveInitials(form.fullName || initial.email);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // ── Save (name, phone, jobTitle) ──────────────────────────────────────
  function handleSave() {
    startSaveTransition(async () => {
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
        if (isStaleSessionError(result.error)) {
          window.location.assign(
            buildStaleSessionRedirectUrl("/dashboard/settings"),
          );
        }
        return;
      }
      const nextInitial: FormState = {
        fullName: result.name,
        email: form.email,
        phone: result.phone ?? "",
        jobTitle: result.jobTitle ?? "",
      };
      setInitial(nextInitial);
      setForm(nextInitial);
      toast.success("Profile updated", {
        id: "profile-saved",
        description: "Your changes have been saved.",
      });
    });
  }

  function handleCancel() {
    setForm(initial);
  }

  // ── Avatar upload flow ────────────────────────────────────────────────
  /**
   * Trigger the native file picker. The hidden `<input type="file">`
   * is owned by this component so the action is keyboard-accessible
   * via the button.
   */
  function handleChangePhotoClick() {
    fileInputRef.current?.click();
  }

  /**
   * Handle the picker's `change` event. Runs the three-step upload:
   *   1. initiateAvatarUpload — get presigned PUT URL + avatarKey
   *   2. fetch(uploadUrl, { PUT, body: file }) — bytes go direct to R2
   *   3. confirmAvatarUpload — write users.avatar_key + audit
   * Then router.refresh() so the next render gets a fresh presigned
   * GET URL via the settings page's SSR read.
   */
  async function handleFileSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    // Reset the input's value so picking the same file again triggers
    // a fresh `change` event next time (browsers suppress the event if
    // the value didn't change).
    event.target.value = "";
    if (!file) return;

    // Pre-flight client checks so we don't even ping the server with
    // an obviously bad file. The action re-validates server-side; these
    // checks just save a round-trip on the obvious-bad cases.
    if (
      !(ALLOWED_AVATAR_MIME_TYPES as readonly string[]).includes(file.type)
    ) {
      toast.error("Unsupported image format", {
        id: "avatar-upload-error",
        description: "Please pick a PNG, JPEG, or WebP image.",
      });
      return;
    }
    if (file.size > MAX_AVATAR_SIZE_BYTES) {
      toast.error("Image too large", {
        id: "avatar-upload-error",
        description: `Maximum size is ${MAX_AVATAR_SIZE_BYTES / (1024 * 1024)} MB.`,
      });
      return;
    }

    setIsUploadingAvatar(true);
    try {
      // Step 1 — mint presigned URL.
      const initResult = await initiateAvatarUpload({
        fileName: file.name,
        mimeType: file.type as (typeof ALLOWED_AVATAR_MIME_TYPES)[number],
        sizeBytes: file.size,
      });
      if (!initResult.ok) {
        toast.error("Couldn't start upload", {
          id: "avatar-upload-error",
          description: initResult.error,
        });
        if (isStaleSessionError(initResult.error)) {
          window.location.assign(
            buildStaleSessionRedirectUrl("/dashboard/settings"),
          );
        }
        return;
      }

      // Step 2 — PUT bytes directly to R2. `Content-Type` MUST match
      // the value the action signed; sigv4 rejects mismatches.
      const putResponse = await fetch(initResult.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": initResult.contentType },
      });
      if (!putResponse.ok) {
        toast.error("Upload failed", {
          id: "avatar-upload-error",
          description: `R2 returned ${putResponse.status}. Try again, or pick a smaller image.`,
        });
        return;
      }

      // Step 3 — confirm. Writes the column + audits + best-effort
      // deletes the previous R2 object.
      const confirmResult = await confirmAvatarUpload({
        avatarKey: initResult.avatarKey,
      });
      if (!confirmResult.ok) {
        toast.error("Couldn't save avatar", {
          id: "avatar-upload-error",
          description: confirmResult.error,
        });
        return;
      }

      toast.success("Avatar updated", {
        id: "avatar-saved",
        description: "Your profile photo is live.",
      });

      // Re-render so the Settings page re-reads the new avatar_key and
      // hands us a fresh presigned GET URL via the SSR boundary.
      router.refresh();
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  function handleDeleteAvatar() {
    startDeleteAvatarTransition(async () => {
      const result = await deleteAvatar();
      if (!result.ok) {
        toast.error("Couldn't remove avatar", {
          id: "avatar-delete-error",
          description: result.error,
        });
        if (isStaleSessionError(result.error)) {
          window.location.assign(
            buildStaleSessionRedirectUrl("/dashboard/settings"),
          );
        }
        return;
      }
      toast.success("Avatar removed", {
        id: "avatar-removed",
        description: "We've cleared your profile photo.",
      });
      router.refresh();
    });
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
                {initialAvatarUrl && (
                  <AvatarImage
                    src={initialAvatarUrl}
                    alt={`${form.fullName || "User"}'s profile photo`}
                  />
                )}
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
            <div className="flex items-center gap-2">
              {initialHasAvatar && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDeleteAvatar}
                  disabled={isUploadingAvatar || isDeletingAvatar}
                  aria-label="Remove profile photo"
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  Remove
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleChangePhotoClick}
                disabled={isUploadingAvatar || isDeletingAvatar}
                aria-busy={isUploadingAvatar}
              >
                <Camera className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {isUploadingAvatar ? "Uploading..." : "Change photo"}
              </Button>
              {/* Hidden picker — opened by the Change photo button. */}
              <input
                ref={fileInputRef}
                type="file"
                accept={AVATAR_ACCEPT_ATTR}
                className="hidden"
                onChange={handleFileSelected}
                aria-hidden
                tabIndex={-1}
              />
            </div>
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
        isSaving={isSavingFields}
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
