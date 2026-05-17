/**
 * Tender form — shared between Create and Edit.
 *
 * Client Component. Owns form state via react-hook-form. Validation runs
 * both client-side (for UX) and server-side (authoritative) using the
 * same Zod schemas from lib/tenders/schemas.ts.
 *
 * Mode is driven by the presence of `initialValues`:
 *
 *   - `initialValues` undefined  → create mode
 *       - calls createTender() Server Action
 *       - validates against createTenderSchema (all required fields enforced)
 *       - redirects to /dashboard/tenders on success
 *       - button reads "Save tender"
 *
 *   - `initialValues` defined    → edit mode
 *       - calls updateTender() Server Action (passing id from initialValues)
 *       - validates against the same schema shape — server uses
 *         updateTenderSchema which accepts partial input
 *       - redirects to /dashboard/tenders/{id} on success
 *       - button reads "Save changes"
 *       - form starts pre-populated with the existing row's values
 *       - fields locked by the state machine (e.g. eligibility filters
 *         when published) render disabled with an explanatory note
 *
 * Architecture mirrors `components/companies/company-form.tsx` (Day 3):
 *   - One form, one submit. Six visually-sectioned blocks via
 *     `<FormSection>` so the user can mentally chunk progress without
 *     wizard friction.
 *   - Inline Zod resolver — avoids the @hookform/resolvers + Zod 4
 *     compatibility issues.
 *   - On-blur validation per field.
 *   - Sticky action bar at the bottom.
 *   - Unsaved-changes guard prompts before tab close / refresh.
 *
 * Publisher override: by default the create flow uses the Consultway
 * sentinel company (resolved server-side when `publisherCompanyId` is
 * omitted). The "Show advanced" toggle reveals a select where staff can
 * pick a different publisher for subcontract tenders. Edit mode hides
 * this section entirely — publisher is set on create and never changes
 * (changing it mid-flight would break audit assumptions and the FK
 * constraint anyway, per actions.ts).
 *
 * @module components/tenders/tender-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Lock,
  Save,
  X,
} from "lucide-react";
import { createTender, updateTender } from "@/lib/tenders/actions";
import {
  createTenderSchema,
  type CreateTenderInput,
} from "@/lib/tenders/schemas";
import { getEditableFieldsForStatus } from "@/lib/tenders/state-machine";
import type { Tender, TenderStatus } from "@/lib/db/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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

// ── Props ─────────────────────────────────────────────────────────────────

/**
 * One option in the publisher dropdown. id+name only — the parent page
 * fetches this list server-side so the client payload stays small.
 */
export interface PublisherOption {
  id: string;
  name: string;
  /**
   * Marks the Consultway sentinel as the default option. The picker
   * pins it to the top and labels it "Consultway Infotech (default)".
   */
  isDefault?: boolean;
}

export interface TenderFormProps {
  /**
   * List of companies eligible to publish a tender. Includes the
   * Consultway sentinel (flagged `isDefault: true`) plus every other
   * non-JV / non-sentinel company. Parent page does the filtering.
   *
   * In edit mode this list is unused — publisher is immutable after
   * create.
   */
  publisherOptions: PublisherOption[];

  /**
   * When present, the form is in EDIT mode and pre-populated with these
   * values. When absent, the form is in CREATE mode.
   */
  initialValues?: Tender;
}

// ── Default values ────────────────────────────────────────────────────────

/**
 * Defaults for CREATE mode. Same blank-string convention as the
 * companies form — empty inputs from the start (no
 * controlled-vs-uncontrolled warnings), normalised back to null at
 * submit time by `normaliseFormValues` + per-field `setValueAs`.
 *
 * `publisherCompanyId` defaults to undefined — the action treats that
 * as "use the Consultway sentinel."
 */
const CREATE_DEFAULTS: CreateTenderInput = {
  title: "",
  description: null,
  referenceNumber: null,
  publisherCompanyId: undefined,
  sector: "",
  geography: "",
  eligibleSector: null,
  eligibleGeography: null,
  minAnnualTurnoverInr: null,
  msmeOnly: false,
  openingDate: null,
  closingDate: null,
  internalNotes: null,
};

/**
 * Build EDIT-mode defaults from a Tender row. Strips fields the form
 * doesn't manage (id, status, publishedAt, createdAt, updatedAt) and
 * normalises empty strings to null.
 *
 * Note: status is intentionally NOT exposed on this form — status
 * transitions happen via dedicated buttons on the detail page
 * (publish / unpublish / close / award). Burying status in the edit
 * form would let staff trip the state machine accidentally.
 */
function buildEditDefaults(tender: Tender): CreateTenderInput {
  return {
    title: tender.title,
    description: tender.description,
    referenceNumber: tender.referenceNumber,
    // Publisher is immutable post-create — include the existing value
    // so the schema's optional check passes, but we won't render an
    // input for it in edit mode.
    publisherCompanyId: tender.publisherCompanyId,
    sector: tender.sector,
    geography: tender.geography,
    eligibleSector: tender.eligibleSector,
    eligibleGeography: tender.eligibleGeography,
    minAnnualTurnoverInr: tender.minAnnualTurnoverInr,
    msmeOnly: tender.msmeOnly,
    openingDate: tender.openingDate,
    closingDate: tender.closingDate,
    internalNotes: tender.internalNotes,
  };
}

// ── Component ─────────────────────────────────────────────────────────────

export function TenderForm({
  publisherOptions,
  initialValues,
}: TenderFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Track whether the "advanced" publisher picker is expanded. Only
  // relevant in create mode — edit mode never shows it.
  const [showPublisherAdvanced, setShowPublisherAdvanced] = useState(false);

  const isEditMode = initialValues !== undefined;

  // Edit-mode field gating: compute which fields the state machine
  // allows for this row's current status. Used to disable inputs and
  // show inline lock indicators. Create mode bypasses this — everything
  // is editable when there's no row yet.
  const status: TenderStatus | null = initialValues?.status ?? null;
  const editableFields = status ? getEditableFieldsForStatus(status) : null;

  /**
   * Check whether a field is editable. In create mode, always true.
   * In edit mode, defer to the state machine. The Set lookup is
   * cheap; calling per-field per-render is fine.
   */
  function isFieldEditable(field: string): boolean {
    if (!editableFields) return true;
    // Use `has` against the typed Set. Casting `as never` because the
    // helper's signature is parameterised on the editable-fields union;
    // here we pass arbitrary strings (every field name on the form).
    return editableFields.has(field as never);
  }

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CreateTenderInput>({
    /**
     * Inline Zod resolver — `safeParse` on every validate call. Both
     * modes validate against `createTenderSchema` for client UX. The
     * server uses `updateTenderSchema` in edit mode (which accepts
     * partial input) — but client-side we want to enforce "the row
     * after edit must still be valid," which means full validation.
     */
    resolver: async (rawValues) => {
      const values = normaliseFormValues(rawValues);
      const result = createTenderSchema.safeParse(values);
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

  // Block tab close / refresh when form is dirty.
  useUnsavedChangesGuard(isDirty && !isSubmitting && !isPending);

  // ── Submit handler ───────────────────────────────────────────────────
  function onSubmit(data: CreateTenderInput) {
    setServerError(null);

    startTransition(async () => {
      const result = isEditMode
        ? await updateTender({ id: initialValues.id, ...data })
        : await createTender(data);

      if (!result.ok) {
        if (result.field) {
          setError(result.field as keyof CreateTenderInput, {
            type: "server",
            message: result.error,
          });
        } else {
          setServerError(result.error);
        }
        return;
      }

      // Success. Destination differs by mode:
      //   - Edit: back to the detail page (just-edited row visible)
      //   - Create: tenders list (new row appears at top)
      router.replace(
        isEditMode
          ? `/dashboard/tenders/${initialValues.id}`
          : "/dashboard/tenders",
      );
    });
  }

  const submitDisabled = isSubmitting || isPending;
  const cancelHref = isEditMode
    ? `/dashboard/tenders/${initialValues.id}`
    : "/dashboard/tenders";

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {/* Top-of-form server error banner. Field errors render inline. */}
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isEditMode ? "Could not save changes" : "Could not save tender"}
          </AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Edit-mode banner explaining locked fields when the tender is
          past draft. Helps staff understand why inputs are disabled
          rather than just feeling stuck. */}
      {isEditMode && status && status !== "draft" && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>
            Some fields are locked because this tender is {status}
          </AlertTitle>
          <AlertDescription>
            {status === "published" &&
              "Eligibility filters are locked once a tender is published. Unpublish to draft (only possible if there are no applications yet) to change them."}
            {(status === "closed" || status === "awarded") &&
              "Only internal notes can be edited on closed or awarded tenders. Other changes are no longer permitted."}
          </AlertDescription>
        </Alert>
      )}

      {/* Section 1: Identity ───────────────────────────────────────── */}
      <FormSection
        title="Identity"
        description="The headline information for this tender."
      >
        <FormField
          name="title"
          label="Tender title"
          required
          error={errors.title?.message}
          className="md:col-span-2"
        >
          <Input
            type="text"
            placeholder="Coastal Road Extension — Civil Works Phase II"
            disabled={submitDisabled || !isFieldEditable("title")}
            {...register("title")}
          />
        </FormField>

        <FormField
          name="referenceNumber"
          label="Reference number"
          description="Optional. Unique when set."
          error={errors.referenceNumber?.message}
        >
          <Input
            type="text"
            placeholder="CW-2026-INFRA-014"
            autoCapitalize="characters"
            disabled={submitDisabled || !isFieldEditable("referenceNumber")}
            {...register("referenceNumber", {
              setValueAs: (v) => (v === "" ? null : v?.toUpperCase()),
            })}
          />
        </FormField>

        <FormField
          name="description"
          label="Description"
          description="Scope of work, deliverables, key dates."
          error={errors.description?.message}
          className="md:col-span-2"
        >
          <Textarea
            rows={5}
            placeholder="Describe the scope, deliverables, and any context applicants need to evaluate the opportunity."
            disabled={submitDisabled || !isFieldEditable("description")}
            {...register("description", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 2: Categorisation ─────────────────────────────────── */}
      <FormSection
        title="Categorisation"
        description="What kind of work and where. Used for browsing and search."
      >
        <FormField
          name="sector"
          label="Sector"
          required
          description="e.g. Infrastructure, Civil Works, Solar EPC"
          error={errors.sector?.message}
        >
          <Input
            type="text"
            placeholder="Infrastructure"
            disabled={submitDisabled || !isFieldEditable("sector")}
            {...register("sector")}
          />
        </FormField>

        <FormField
          name="geography"
          label="Geography"
          required
          description="e.g. Pan India, Maharashtra, Delhi NCR"
          error={errors.geography?.message}
        >
          <Input
            type="text"
            placeholder="Pan India"
            disabled={submitDisabled || !isFieldEditable("geography")}
            {...register("geography")}
          />
        </FormField>
      </FormSection>

      {/* Section 3: Eligibility filters ────────────────────────────── */}
      <FormSection
        title="Eligibility filters"
        description="Constraints that applying companies must meet. Leave blank for no restriction. Locked once the tender is published."
      >
        <FormField
          name="eligibleSector"
          label="Required sector"
          description="Applicants must match this exact sector."
          error={errors.eligibleSector?.message}
        >
          <Input
            type="text"
            placeholder="e.g. Roads & Highways"
            disabled={submitDisabled || !isFieldEditable("eligibleSector")}
            {...register("eligibleSector", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="eligibleGeography"
          label="Required geography"
          description="Applicants must operate in this geography."
          error={errors.eligibleGeography?.message}
        >
          <Input
            type="text"
            placeholder="e.g. Maharashtra"
            disabled={submitDisabled || !isFieldEditable("eligibleGeography")}
            {...register("eligibleGeography", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="minAnnualTurnoverInr"
          label="Minimum annual turnover (INR)"
          description="Whole rupees. Enforcement ships when companies start recording turnover."
          error={errors.minAnnualTurnoverInr?.message}
        >
          <Controller
            name="minAnnualTurnoverInr"
            control={control}
            render={({ field }) => (
              <div className="space-y-1">
                <div className="relative">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                  >
                    ₹
                  </span>
                  <Input
                    id="minAnnualTurnoverInr"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    className="pl-7"
                    placeholder="50000000"
                    disabled={
                      submitDisabled || !isFieldEditable("minAnnualTurnoverInr")
                    }
                    value={field.value ?? ""}
                    onChange={(e) => {
                      // Empty input → null. Non-empty → coerce to int.
                      const raw = e.target.value;
                      if (raw === "") {
                        field.onChange(null);
                        return;
                      }
                      const n = Number(raw);
                      // Reject NaN; keep prior value rather than poisoning state.
                      field.onChange(Number.isFinite(n) ? Math.trunc(n) : field.value);
                    }}
                    onBlur={field.onBlur}
                  />
                </div>
                {/* Indian-locale grouped echo so users can sanity-check
                    a big number at a glance. Example: 50000000 →
                    ₹ 5,00,00,000 */}
                {typeof field.value === "number" && field.value > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {formatInr(field.value)}
                  </p>
                )}
              </div>
            )}
          />
        </FormField>

        <FormField
          name="msmeOnly"
          label="MSME-only"
          description="Restrict applications to MSME-registered companies."
          error={errors.msmeOnly?.message}
        >
          <Controller
            name="msmeOnly"
            control={control}
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <Switch
                  id="msmeOnly"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={submitDisabled || !isFieldEditable("msmeOnly")}
                />
                <span className="text-sm text-muted-foreground">
                  {field.value ? "Yes" : "No"}
                </span>
              </div>
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 4: Dates ──────────────────────────────────────────── */}
      <FormSection
        title="Application window"
        description="Optional. Leave blank for open-ended tenders."
      >
        <FormField
          name="openingDate"
          label="Opening date"
          description="When applications open. Default: immediately on publish."
          error={errors.openingDate?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled || !isFieldEditable("openingDate")}
            {...register("openingDate", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="closingDate"
          label="Closing date"
          description="After this date, no new applications accepted."
          error={errors.closingDate?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled || !isFieldEditable("closingDate")}
            {...register("closingDate", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 5: Publisher (create mode only, behind a toggle) ──── */}
      {!isEditMode && (
        <FormSection
          title="Publisher"
          description="By default, this tender is published by Consultway Infotech. Override only for subcontract tenders where a registered company is the issuer."
          layout="stack"
        >
          <div>
            <button
              type="button"
              onClick={() => setShowPublisherAdvanced((s) => !s)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={showPublisherAdvanced}
              aria-controls="publisher-advanced"
            >
              {showPublisherAdvanced ? (
                <ChevronDown className="h-4 w-4" aria-hidden />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden />
              )}
              {showPublisherAdvanced ? "Hide advanced" : "Show advanced"}
            </button>

            {showPublisherAdvanced && (
              <div id="publisher-advanced" className="mt-3">
                <FormField
                  name="publisherCompanyId"
                  label="Publisher company"
                  description="Defaults to Consultway Infotech. Pick a registered company for a subcontract tender."
                  error={errors.publisherCompanyId?.message}
                >
                  <Controller
                    name="publisherCompanyId"
                    control={control}
                    render={({ field }) => (
                      <Select
                        // Pass undefined (not "") when no value — Radix
                        // Select rejects empty-string values, but undefined
                        // is treated as "no selection" and renders the
                        // placeholder. The Controller's `field.value` is
                        // undefined by default in create mode.
                        value={field.value || undefined}
                        onValueChange={(v) => field.onChange(v || undefined)}
                        disabled={submitDisabled}
                      >
                        <SelectTrigger aria-label="Publisher company">
                          <SelectValue placeholder="Consultway Infotech (default)" />
                        </SelectTrigger>
                        <SelectContent>
                          {publisherOptions.map((opt) => (
                            <SelectItem key={opt.id} value={opt.id}>
                              {opt.name}
                              {opt.isDefault ? " (default)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </FormField>
              </div>
            )}
          </div>
        </FormSection>
      )}

      {/* Section 6: Internal notes — staff only */}
      <FormSection
        title="Internal notes"
        description="Only visible to Consultway staff. Not shared with applying companies."
        layout="stack"
      >
        <FormField
          name="internalNotes"
          label="Notes"
          error={errors.internalNotes?.message}
        >
          <Textarea
            rows={4}
            placeholder="Background, evaluation criteria worth recording, follow-up reminders."
            disabled={submitDisabled || !isFieldEditable("internalNotes")}
            {...register("internalNotes", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Sticky bottom action bar */}
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
              : "Save tender"}
        </Button>
      </StickyActionBar>
    </form>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert form values from RHF (where empty inputs are empty strings)
 * to the shape Zod's `createTenderSchema` expects (where optional
 * absent fields are null and numeric coercions work).
 *
 * `register` with `setValueAs` already does this per-field, but we
 * defensively run it at the form level as well — covers the case where
 * a field is set via Controller (where setValueAs doesn't apply).
 *
 * Special case for publisherCompanyId: empty string from the picker
 * becomes undefined (not null) so the schema's `.optional()` treats it
 * as "use the action's default" rather than "explicitly null which is
 * rejected by uuidSchema".
 */
function normaliseFormValues(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value === "") {
      // publisherCompanyId is optional (not nullable in the schema).
      // Map "" → undefined so the optional check passes.
      out[key] = key === "publisherCompanyId" ? undefined : null;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Format a rupee integer with Indian-locale grouping (lakh / crore
 * commas) for the live-echo helper line under the turnover input.
 *
 * Example: 50000000 → "₹ 5,00,00,000".
 *
 * Uses `Intl.NumberFormat` with the en-IN locale; output is consistent
 * across Node, browsers, and the V8 isolate the form runs in.
 */
function formatInr(rupees: number): string {
  const formatter = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  });
  return `₹ ${formatter.format(rupees)}`;
}
