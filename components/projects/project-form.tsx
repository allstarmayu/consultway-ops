/**
 * Project form — shared between Create and Edit.
 *
 * Client Component. Owns form state via react-hook-form with the same
 * inline-Zod-resolver pattern as the companies form (Day 4) — avoids
 * `@hookform/resolvers + Zod 4` compatibility issues.
 *
 * Mode is driven by the presence of `initialValues`:
 *
 *   - `initialValues` undefined  → create mode
 *       - calls createProject() Server Action
 *       - validates against createProjectSchema (companyId required)
 *       - redirects to /dashboard/projects on success
 *       - button reads "Save project"
 *
 *   - `initialValues` defined    → edit mode
 *       - calls updateProject() Server Action (passing id from
 *         initialValues — companyId is NOT mutable post-create)
 *       - validates against the full create schema for the form-level
 *         "the row after edit must still be valid" check; the server
 *         uses updateProjectSchema (partial) for the actual write.
 *       - redirects to /dashboard/projects/{id} on success
 *       - companyId field is rendered read-only — admins / staff don't
 *         re-assign a project to a different company via this form
 *
 * RBAC at the form level:
 *   - admin / staff — every section editable
 *   - company role  — only the description field is editable; other
 *                     inputs render disabled. The server-side action
 *                     enforces the same gate (defence in depth).
 *
 * @module components/projects/project-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { AlertCircle, Save, X } from "lucide-react";
import { createProject, updateProject } from "@/lib/projects/actions";
import {
  createProjectSchema,
  type CreateProjectInput,
} from "@/lib/projects/schemas";
import type { Project } from "@/lib/db/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { StickyActionBar } from "@/components/forms/sticky-action-bar";
import { useUnsavedChangesGuard } from "@/components/forms/use-unsaved-changes-guard";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyOption {
  id: string;
  name: string;
}

export interface ProjectFormProps {
  /**
   * Eligible owning companies. The Select renders one option per row.
   * In edit mode this list is informational only — the select is
   * disabled because companyId isn't editable post-create.
   */
  companyOptions: CompanyOption[];

  /**
   * When present, the form is in EDIT mode. When absent, CREATE mode.
   */
  initialValues?: Project;

  /**
   * Field-level mode. Drives whether non-description fields are
   * disabled.
   *
   *   - "full"             — admin/staff edit; all fields enabled
   *   - "description-only" — company-role edit; only `description` is
   *                          enabled; everything else is read-only
   */
  fieldMode: "full" | "description-only";
}

// ── Default values ──────────────────────────────────────────────────────────

const CREATE_DEFAULTS: CreateProjectInput = {
  companyId: "",
  name: "",
  description: null,
  tenderId: null,
  startDate: null,
  endDate: null,
  budgetInr: null,
  internalNotes: null,
};

function buildEditDefaults(project: Project): CreateProjectInput {
  return {
    companyId: project.companyId,
    name: project.name,
    description: project.description,
    tenderId: project.tenderId,
    startDate: project.startDate,
    endDate: project.endDate,
    budgetInr: project.budgetInr,
    internalNotes: project.internalNotes,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export function ProjectForm({
  companyOptions,
  initialValues,
  fieldMode,
}: ProjectFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isEditMode = initialValues !== undefined;
  const isDescriptionOnly = fieldMode === "description-only";

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CreateProjectInput>({
    resolver: async (rawValues) => {
      const values = normaliseFormValues(rawValues);

      const result = createProjectSchema.safeParse(values);
      if (result.success) {
        return { values: result.data, errors: {} };
      }
      const errs: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        if (path && !errs[path]) {
          errs[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors: errs };
    },
    defaultValues: isEditMode
      ? buildEditDefaults(initialValues)
      : CREATE_DEFAULTS,
    mode: "onBlur",
  });

  useUnsavedChangesGuard(isDirty && !isSubmitting && !isPending);

  function onSubmit(data: CreateProjectInput) {
    setServerError(null);

    startTransition(async () => {
      const result = isEditMode
        ? await updateProject({
            id: initialValues.id,
            name: data.name,
            description: data.description,
            startDate: data.startDate,
            endDate: data.endDate,
            budgetInr: data.budgetInr,
            internalNotes: data.internalNotes,
          })
        : await createProject(data);

      if (!result.ok) {
        if (result.field) {
          setError(result.field as keyof CreateProjectInput, {
            type: "server",
            message: result.error,
          });
        } else {
          setServerError(result.error);
        }
        return;
      }

      router.replace(
        isEditMode
          ? `/dashboard/projects/${initialValues.id}`
          : "/dashboard/projects",
      );
    });
  }

  const submitDisabled = isSubmitting || isPending;
  const cancelHref = isEditMode
    ? `/dashboard/projects/${initialValues.id}`
    : "/dashboard/projects";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isEditMode ? "Could not save changes" : "Could not save project"}
          </AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Section 1: Identity ─────────────────────────────────────── */}
      <FormSection
        title="Identity"
        description="Basic information about the project."
      >
        <FormField
          name="companyId"
          label="Company"
          required
          error={errors.companyId?.message}
          className="md:col-span-2"
        >
          <Controller
            name="companyId"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value || undefined}
                onValueChange={field.onChange}
                disabled={submitDisabled || isEditMode || isDescriptionOnly}
              >
                <SelectTrigger aria-label="Owning company">
                  <SelectValue placeholder="Select a company..." />
                </SelectTrigger>
                <SelectContent>
                  {companyOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>

        <FormField
          name="name"
          label="Project name"
          required
          error={errors.name?.message}
          className="md:col-span-2"
        >
          <Input
            type="text"
            placeholder="Pune fly-over consulting engagement"
            disabled={submitDisabled || isDescriptionOnly}
            {...register("name")}
          />
        </FormField>

        <FormField
          name="description"
          label="Description"
          description="Optional context — scope, key deliverables, stakeholders."
          error={errors.description?.message}
          className="md:col-span-2"
        >
          <Textarea
            rows={4}
            placeholder="Brief description of the project..."
            disabled={submitDisabled}
            {...register("description", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 2: Schedule ─────────────────────────────────────── */}
      <FormSection
        title="Schedule"
        description="Optional planned start and end dates."
      >
        <FormField
          name="startDate"
          label="Start date"
          error={errors.startDate?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled || isDescriptionOnly}
            {...register("startDate", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="endDate"
          label="End date"
          error={errors.endDate?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled || isDescriptionOnly}
            {...register("endDate", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 3: Budget ──────────────────────────────────────── */}
      <FormSection
        title="Budget"
        description="Total project budget in INR (whole rupees, no paise)."
        layout="stack"
      >
        <FormField
          name="budgetInr"
          label="Budget (INR)"
          error={errors.budgetInr?.message}
        >
          <Controller
            name="budgetInr"
            control={control}
            render={({ field }) => (
              <div className="relative">
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                >
                  ₹
                </span>
                <Input
                  id="budgetInr"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  className="pl-7"
                  placeholder="5000000"
                  disabled={submitDisabled || isDescriptionOnly}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      field.onChange(null);
                      return;
                    }
                    const n = Number(raw);
                    field.onChange(
                      Number.isFinite(n) ? Math.trunc(n) : field.value,
                    );
                  }}
                  onBlur={field.onBlur}
                />
              </div>
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 4: Internal notes — staff only */}
      {!isDescriptionOnly && (
        <FormSection
          title="Internal notes"
          description="Only visible to Consultway staff. Not shared with the company."
          layout="stack"
        >
          <FormField
            name="internalNotes"
            label="Notes"
            error={errors.internalNotes?.message}
          >
            <Textarea
              rows={4}
              placeholder="Risks, blockers, follow-ups, internal context."
              disabled={submitDisabled}
              {...register("internalNotes", {
                setValueAs: (v) => (v === "" ? null : v),
              })}
            />
          </FormField>
        </FormSection>
      )}

      <StickyActionBar
        helper={
          <span>
            <span aria-hidden className="text-destructive">
              *
            </span>{" "}
            indicates a required field
          </span>
        }
      >
        <Button
          type="button"
          variant="outline"
          disabled={submitDisabled}
          onClick={() => router.push(cancelHref)}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          <Save className="h-4 w-4" aria-hidden />
          {submitDisabled
            ? "Saving..."
            : isEditMode
              ? "Save changes"
              : "Save project"}
        </Button>
      </StickyActionBar>
    </form>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normaliseFormValues(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value === "") {
      out[key] = null;
    } else {
      out[key] = value;
    }
  }
  return out;
}
