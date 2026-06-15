/**
 * User form — shared between Invite (create) and Edit.
 *
 * Client Component. Owns form state via react-hook-form with an inline Zod
 * resolver (same pattern as the company form — avoids the @hookform/resolvers
 * + Zod 4 friction). Validates against `createUserSchema` in both modes so
 * the role ↔ company invariant is enforced client-side before the round-trip.
 *
 * Mode is driven by `initialValues`:
 *   - undefined → CREATE (invite): calls `createUser`. No password field —
 *     the invitee sets their own via the emailed link. On success, toasts
 *     the invite outcome and routes to the new user's detail page.
 *   - defined   → EDIT: calls `updateUser`. Email is shown read-only
 *     (changing a login email needs re-verification — a separate flow).
 *
 * @module components/users/user-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { AlertCircle, Save, Send, X } from "lucide-react";
import { createUser, updateUser } from "@/lib/users/actions";
import { createUserSchema } from "@/lib/users/schemas";
import type { UserRole } from "@/lib/db/schema";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormSection } from "@/components/forms/form-section";
import { FormField } from "@/components/forms/form-field";

// ── Props ────────────────────────────────────────────────────────────────────

/**
 * Minimal shape the form needs in edit mode. A `UserWithCompany` row (from
 * `getUser`) is structurally assignable to this, so the edit page can pass
 * its fetched row directly.
 */
export interface UserFormInitialValues {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  phone: string | null;
  jobTitle: string | null;
}

export interface UserFormProps {
  /** Companies for the company-role link picker (id + name only). */
  companies: Array<{ id: string; name: string }>;
  /** Present → EDIT mode, pre-populated. Absent → CREATE (invite) mode. */
  initialValues?: UserFormInitialValues;
}

interface UserFormValues {
  name: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  phone: string | null;
  jobTitle: string | null;
}

const CREATE_DEFAULTS: UserFormValues = {
  name: "",
  email: "",
  role: "staff",
  companyId: null,
  phone: null,
  jobTitle: null,
};

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "staff", label: "Staff" },
  { value: "company", label: "Company" },
];

export function UserForm({ companies, initialValues }: UserFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isEditMode = initialValues !== undefined;

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    setError,
    formState: { errors },
  } = useForm<UserFormValues>({
    resolver: async (raw) => {
      // Normalise blank optionals to null, as Zod expects.
      const values: UserFormValues = {
        name: raw.name ?? "",
        email: raw.email ?? "",
        role: raw.role,
        companyId: raw.role === "company" ? (raw.companyId ?? null) : null,
        phone: raw.phone === "" ? null : (raw.phone ?? null),
        jobTitle: raw.jobTitle === "" ? null : (raw.jobTitle ?? null),
      };
      const result = createUserSchema.safeParse(values);
      if (result.success) return { values, errors: {} };
      const fieldErrors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        if (path && !fieldErrors[path]) {
          fieldErrors[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors: fieldErrors };
    },
    defaultValues: initialValues
      ? {
          name: initialValues.name,
          email: initialValues.email,
          role: initialValues.role,
          companyId: initialValues.companyId,
          phone: initialValues.phone,
          jobTitle: initialValues.jobTitle,
        }
      : CREATE_DEFAULTS,
    mode: "onBlur",
  });

  const role = watch("role");
  const showCompany = role === "company";

  function onSubmit(data: UserFormValues) {
    setServerError(null);
    startTransition(async () => {
      if (isEditMode) {
        const result = await updateUser({
          id: initialValues.id,
          name: data.name,
          role: data.role,
          companyId: data.role === "company" ? data.companyId : null,
          phone: data.phone,
          jobTitle: data.jobTitle,
        });
        if (!result.ok) {
          applyError(result);
          return;
        }
        toast.success("Changes saved");
        router.replace(`/dashboard/admin/users/${initialValues.id}`);
        return;
      }

      const result = await createUser({
        email: data.email,
        name: data.name,
        role: data.role,
        companyId: data.role === "company" ? data.companyId : null,
        phone: data.phone,
        jobTitle: data.jobTitle,
      });
      if (!result.ok) {
        applyError(result);
        return;
      }
      if (result.inviteEmailSent) {
        toast.success(`Invite sent to ${data.email}`);
      } else {
        toast.warning(
          "User created, but the invite email couldn't be sent. Use “Resend invite” on their profile.",
        );
      }
      router.replace(`/dashboard/admin/users/${result.id}`);
    });
  }

  function applyError(result: { error: string; field?: string }) {
    if (result.field) {
      setError(result.field as keyof UserFormValues, {
        type: "server",
        message: result.error,
      });
    } else {
      setServerError(result.error);
    }
  }

  const cancelHref = isEditMode
    ? `/dashboard/admin/users/${initialValues.id}`
    : "/dashboard/admin/users";

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isEditMode ? "Could not save changes" : "Could not invite user"}
          </AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Identity ──────────────────────────────────────────────────── */}
      <FormSection title="Identity" description="Who this user is.">
        <FormField
          name="name"
          label="Full name"
          required
          error={errors.name?.message}
        >
          <Input
            type="text"
            placeholder="Priya Sharma"
            disabled={isPending}
            {...register("name")}
          />
        </FormField>

        <FormField
          name="email"
          label="Email"
          required
          description={
            isEditMode
              ? "Login email can't be changed here."
              : "The invite link is sent to this address."
          }
          error={errors.email?.message}
        >
          <Input
            type="email"
            placeholder="priya@consultway.info"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={isPending || isEditMode}
            readOnly={isEditMode}
            {...register("email")}
          />
        </FormField>
      </FormSection>

      {/* Access ────────────────────────────────────────────────────── */}
      <FormSection
        title="Access"
        description="Role determines what this user can see and do."
      >
        <FormField name="role" label="Role" required error={errors.role?.message}>
          <Controller
            name="role"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v as UserRole);
                  // Clear the company link when leaving the company role so
                  // the invariant holds and the picker hides.
                  if (v !== "company") setValue("companyId", null);
                }}
                disabled={isPending}
              >
                <SelectTrigger
                  id="role"
                  aria-label="Role"
                  aria-invalid={!!errors.role}
                  aria-describedby={errors.role ? "role-error" : undefined}
                >
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>

        {showCompany && (
          <FormField
            name="companyId"
            label="Company"
            required
            description="The company this user belongs to."
            error={errors.companyId?.message}
          >
            <Controller
              name="companyId"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value ?? undefined}
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <SelectTrigger
                    id="companyId"
                    aria-label="Company"
                    aria-invalid={!!errors.companyId}
                    aria-describedby={
                      errors.companyId ? "companyId-error" : undefined
                    }
                  >
                    <SelectValue placeholder="Select a company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        No companies available
                      </div>
                    ) : (
                      companies.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        )}
      </FormSection>

      {/* Profile ───────────────────────────────────────────────────── */}
      <FormSection
        title="Profile"
        description="Optional contact details, shown on their profile."
      >
        <FormField name="phone" label="Phone" error={errors.phone?.message}>
          <Input
            type="tel"
            placeholder="+91 ..."
            disabled={isPending}
            {...register("phone", { setValueAs: (v) => (v === "" ? null : v) })}
          />
        </FormField>

        <FormField
          name="jobTitle"
          label="Job title"
          error={errors.jobTitle?.message}
        >
          <Input
            type="text"
            placeholder="Project Manager"
            disabled={isPending}
            {...register("jobTitle", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Action row */}
      <div className="flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => router.push(cancelHref)}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isEditMode ? (
            <>
              <Save className="h-4 w-4" aria-hidden />
              {isPending ? "Saving..." : "Save changes"}
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden />
              {isPending ? "Sending invite..." : "Send invite"}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
