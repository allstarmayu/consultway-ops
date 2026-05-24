/**
 * Company form — shared between Create and Edit.
 *
 * Client Component. Owns form state via react-hook-form. Validation runs
 * both client-side (for UX) and server-side (authoritative) using the
 * same Zod schemas from lib/companies/schemas.ts.
 *
 * Mode is driven by the presence of `initialValues`:
 *
 *   - `initialValues` undefined  → create mode
 *       - calls createCompany() Server Action
 *       - validates against createCompanySchema (all required fields enforced)
 *       - redirects to /dashboard/companies on success
 *       - button reads "Save company"
 *
 *   - `initialValues` defined    → edit mode
 *       - calls updateCompany() Server Action (passing id from initialValues)
 *       - validates against the same schema shape — server uses
 *         updateCompanySchema which accepts partial input
 *       - redirects to /dashboard/companies/{id} on success
 *       - button reads "Save changes"
 *       - form starts pre-populated with the existing row's values
 *
 * Architecture:
 *   - One form, one submit. Sectioned blocks via `<FormSection>` so the
 *     user can mentally chunk progress without wizard friction.
 *   - Inline Zod resolver (same pattern as login) — avoids the
 *     @hookform/resolvers + Zod 4 compatibility issues.
 *   - On-blur validation per field — surface errors next to the field
 *     the user just left, not in a wall at submit time.
 *   - Sticky action bar at the bottom so Cancel / Save stay reachable
 *     while scrolling.
 *   - Unsaved-changes guard prompts before tab close / refresh.
 *
 * @module components/companies/company-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { AlertCircle, Save, X } from "lucide-react";
import { createCompany, updateCompany } from "@/lib/companies/actions";
import {
  createCompanySchema,
  type CreateCompanyInput,
} from "@/lib/companies/schemas";
import { formatInr } from "@/lib/format/inr";
import type { Company, UserRole } from "@/lib/db/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FormSection } from "@/components/forms/form-section";
import { FormField } from "@/components/forms/form-field";
import { StickyActionBar } from "@/components/forms/sticky-action-bar";
import { useUnsavedChangesGuard } from "@/components/forms/use-unsaved-changes-guard";
import { PartnerPicker } from "@/app/dashboard/companies/new/_components/partner-picker";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyFormProps {
  /**
   * Existing companies for the JV partner picker typeahead. id+name
   * only — fetched server-side in the parent page.
   *
   * In edit mode, the current company is filtered out of this list so
   * a company can't list itself as its own JV partner. The parent page
   * handles this filtering before passing the list down.
   */
  existingCompanies: Array<{ id: string; name: string }>;

  /**
   * When present, the form is in EDIT mode and pre-populated with these
   * values. When absent, the form is in CREATE mode.
   *
   * We accept the full Company row (not just the form-shape input)
   * because the parent fetches the row anyway, and reusing the type
   * keeps the call site clean.
   */
  initialValues?: Company;

  /**
   * Viewer role. Required prop — drives the conditional render of the
   * Rejection-reason section in edit mode. Company-role users never
   * see that section even on a self-edit of their own (rejected) row.
   * Mirrors the same role-gate the company-header callout uses.
   */
  viewerRole: UserRole;
}

/**
 * Shape of the form's RHF state. Extends `CreateCompanyInput` with
 * `rejectionReason` — surfaced only in edit mode for admin/staff on a
 * rejected company. We keep it in the form state in every mode so the
 * resolver / submit branches don't have to special-case its absence.
 */
type CompanyFormValues = CreateCompanyInput & {
  rejectionReason: string | null;
};

/**
 * Shape passed to `updateCompany` from edit mode. The server's
 * `updateCompanySchema` accepts every field as optional + an id;
 * locally we model the same superset so the submit branch can build
 * the payload without an `as` cast.
 */
type UpdateCompanyPayload = Partial<CompanyFormValues> & { id: string };

// ── Default values ──────────────────────────────────────────────────────────

/**
 * Defaults for CREATE mode. All optional fields default to empty string
 * (controlled inputs from the start, no controlled-vs-uncontrolled
 * warnings) and get normalised back to null at submit time.
 *
 * `annualTurnover` defaults to `null` rather than empty string because
 * it's a numeric field — the Controller-driven input below renders the
 * empty UI when the value is null/undefined.
 */
const CREATE_DEFAULTS: CompanyFormValues = {
  name: "",
  sector: "",
  geography: "",
  gstNumber: null,
  panNumber: null,
  isMsme: false,
  isJv: false,
  parentCompanyIds: null,
  annualTurnover: null,
  contactEmail: null,
  contactPhone: null,
  contactPersonName: null,
  addressLine: null,
  city: null,
  state: null,
  pincode: null,
  internalNotes: null,
  // Never set on create — complianceStatus is forced to "pending" by
  // the action, so there's no rejected-state path through createCompany.
  rejectionReason: null,
};

/**
 * Build EDIT-mode defaults from a Company row. Strips fields the form
 * doesn't manage (id, complianceStatus, createdAt, updatedAt) and
 * normalises empty strings to null.
 *
 * Note: complianceStatus is intentionally NOT exposed on this form.
 * It's a staff-only field that should be changed deliberately on a
 * separate workflow (not buried in a CRUD edit form). When that
 * workflow ships, it'll have its own dedicated UI.
 */
function buildEditDefaults(company: Company): CompanyFormValues {
  return {
    name: company.name,
    sector: company.sector,
    geography: company.geography,
    gstNumber: company.gstNumber,
    panNumber: company.panNumber,
    isMsme: company.isMsme,
    isJv: company.isJv,
    parentCompanyIds: company.parentCompanyIds,
    annualTurnover: company.annualTurnover,
    contactEmail: company.contactEmail,
    contactPhone: company.contactPhone,
    contactPersonName: company.contactPersonName,
    addressLine: company.addressLine,
    city: company.city,
    state: company.state,
    pincode: company.pincode,
    internalNotes: company.internalNotes,
    // Pre-fill the rejection reason for edit mode. Already null for
    // non-rejected rows (and for company-role viewers — getCompany
    // strips the field). The form's conditional render keeps the
    // section hidden in those cases.
    rejectionReason: company.rejectionReason,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyForm({
  existingCompanies,
  initialValues,
  viewerRole,
}: CompanyFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isEditMode = initialValues !== undefined;

  // Conditional render gate for the rejection-reason section. Mirrors
  // the company-header callout: admin/staff only, edit mode, and the
  // row's current compliance status is rejected. Company-role viewers
  // never see the section even on a self-edit.
  const showRejectionReason =
    isEditMode &&
    (viewerRole === "admin" || viewerRole === "staff") &&
    initialValues.complianceStatus === "rejected";

  const {
    register,
    handleSubmit,
    control,
    watch,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CompanyFormValues>({
    /**
     * Inline Zod resolver — `safeParse` on every validate call. Same
     * structure as login: success → values + empty errors; failure →
     * empty values + field-keyed error map.
     *
     * Both modes use `createCompanySchema` for client-side validation.
     * The server uses updateCompanySchema for edit, which accepts
     * partial input — but client-side we want to enforce "the row
     * after edit must still be valid" which means full validation.
     *
     * `rejectionReason` is not part of `createCompanySchema` (it's an
     * update-only field) so the schema strips it on parse. We re-merge
     * the raw value back into the resolver's return so RHF keeps it in
     * its state, and apply a client-side "required when shown" check
     * separately below.
     */
    resolver: async (rawValues) => {
      // Normalise blanks: optional text fields where the input was
      // never touched come through as "". Zod expects null for those.
      const values = normaliseFormValues(rawValues);

      const result = createCompanySchema.safeParse(values);
      const rejectionReasonRaw = values.rejectionReason as
        | string
        | null
        | undefined;
      const rejectionReason =
        typeof rejectionReasonRaw === "string"
          ? rejectionReasonRaw
          : (rejectionReasonRaw ?? null);

      // Defence-in-depth client-side check that mirrors the server's
      // `updateCompanySchema` superRefine: when the rejection-reason
      // section is rendered, the field is effectively required. The
      // server enforces the same contract on every patch path; this
      // check just surfaces the error inline before the round-trip.
      const errs: Record<string, { type: string; message: string }> = {};
      if (showRejectionReason) {
        const trimmed = typeof rejectionReason === "string"
          ? rejectionReason.trim()
          : "";
        if (trimmed.length === 0) {
          errs.rejectionReason = {
            type: "required",
            message: "A rejection reason is required for rejected companies",
          };
        }
      }

      if (result.success) {
        const merged: CompanyFormValues = {
          ...result.data,
          rejectionReason,
        };
        return {
          values: Object.keys(errs).length === 0 ? merged : {},
          errors: errs,
        };
      }
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

  // Block tab close / refresh when form is dirty (and not currently
  // being submitted — we don't want the prompt during the redirect).
  useUnsavedChangesGuard(isDirty && !isSubmitting && !isPending);

  // Watch isJv to conditionally show the partner picker.
  const isJv = watch("isJv");

  // ── Submit handler ────────────────────────────────────────────────────────
  //
  // Branches on mode. Both branches use startTransition for the action
  // call (drives button disabled state) but fire-and-forget the
  // navigation so the transition can settle without waiting on the
  // destination's RSC payload.

  function onSubmit(data: CompanyFormValues) {
    setServerError(null);

    startTransition(async () => {
      // Split rejectionReason out so create-mode submits stay unchanged
      // (createCompany doesn't accept the field) and edit-mode submits
      // only carry it when the section was actually rendered. Sending
      // it unconditionally on every edit would risk a no-op patch
      // clearing the reason on a non-rejected row.
      const { rejectionReason, ...rest } = data;

      let result;
      if (isEditMode) {
        const payload: UpdateCompanyPayload = {
          id: initialValues.id,
          ...rest,
        };
        if (showRejectionReason) {
          payload.rejectionReason = rejectionReason;
        }
        result = await updateCompany(payload);
      } else {
        result = await createCompany(rest);
      }

      if (!result.ok) {
        // Field-targeted error → highlight the offending input.
        if (result.field) {
          setError(result.field as keyof CompanyFormValues, {
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
      //   - Create: companies list (new row appears at top)
      router.replace(
        isEditMode
          ? `/dashboard/companies/${initialValues.id}`
          : "/dashboard/companies",
      );
    });
  }

  const submitDisabled = isSubmitting || isPending;
  const cancelHref = isEditMode
    ? `/dashboard/companies/${initialValues.id}`
    : "/dashboard/companies";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {/* Top-of-form server error banner. Field errors render inline. */}
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isEditMode ? "Could not save changes" : "Could not save company"}
          </AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Section 1: Identity ─────────────────────────────────────── */}
      <FormSection
        title="Identity"
        description="Basic information about the company."
      >
        <FormField
          name="name"
          label="Company name"
          required
          error={errors.name?.message}
          className="md:col-span-2"
        >
          <Input
            type="text"
            placeholder="Acme Construction Pvt Ltd"
            disabled={submitDisabled}
            {...register("name")}
          />
        </FormField>

        <FormField
          name="sector"
          label="Sector"
          required
          description="e.g. Infrastructure, Civil Works, IT Services"
          error={errors.sector?.message}
        >
          <Input
            type="text"
            placeholder="Infrastructure"
            disabled={submitDisabled}
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
            disabled={submitDisabled}
            {...register("geography")}
          />
        </FormField>
      </FormSection>

      {/* Section 2: Identifiers ──────────────────────────────────── */}
      <FormSection
        title="Identifiers"
        description="GST and PAN can be added later — leave blank if not yet available."
      >
        <FormField
          name="gstNumber"
          label="GSTIN"
          description="15 characters, government-issued"
          error={errors.gstNumber?.message}
        >
          <Input
            type="text"
            placeholder="27ABCDE1234F1Z5"
            autoCapitalize="characters"
            disabled={submitDisabled}
            {...register("gstNumber", {
              setValueAs: (v) => (v === "" ? null : v?.toUpperCase()),
            })}
          />
        </FormField>

        <FormField
          name="panNumber"
          label="PAN"
          description="10 characters"
          error={errors.panNumber?.message}
        >
          <Input
            type="text"
            placeholder="ABCDE1234F"
            autoCapitalize="characters"
            disabled={submitDisabled}
            {...register("panNumber", {
              setValueAs: (v) => (v === "" ? null : v?.toUpperCase()),
            })}
          />
        </FormField>

        <FormField
          name="isMsme"
          label="MSME registered"
          description="Toggle on if the company is registered under the MSME scheme."
          error={errors.isMsme?.message}
        >
          <Controller
            name="isMsme"
            control={control}
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <Switch
                  id="isMsme"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={submitDisabled}
                />
                <span className="text-sm text-muted-foreground">
                  {field.value ? "Yes" : "No"}
                </span>
              </div>
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 3: Commercial profile ───────────────────────────── */}
      {/*
        New section as of Day 8. Sits between Identifiers (which covers
        GST/PAN/MSME) and Joint venture so the form's flow reads:
        "who you are" -> "your papers" -> "your finances" -> "your
        structure." Single field today; the section title is generic
        enough to absorb future commercial fields (paid-up capital,
        working-capital line, banker reference) without renaming.

        Controller-wrapped because the field is numeric — RHF's plain
        `register` on a number input round-trips through string and
        loses NaN handling. The implementation mirrors the tender form's
        `minAnnualTurnoverInr` input exactly: leading ₹ glyph inside the
        input, empty string -> null, non-empty -> truncated int, live
        en-IN echo below for sanity-check.
      */}
      <FormSection
        title="Commercial profile"
        description="Financial information used to determine eligibility for tenders that set a minimum turnover requirement."
        layout="stack"
      >
        <FormField
          name="annualTurnover"
          label="Annual turnover (INR)"
          description="Whole rupees. Optional, but tenders that set a minimum will reject applications from companies without a stated figure."
          error={errors.annualTurnover?.message}
        >
          <Controller
            name="annualTurnover"
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
                    id="annualTurnover"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    className="pl-7"
                    placeholder="10000000"
                    disabled={submitDisabled}
                    value={field.value ?? ""}
                    onChange={(e) => {
                      // Empty input → null. Non-empty → coerce to int.
                      // Identical handling to the tender form so the
                      // two fields stay behaviourally consistent.
                      const raw = e.target.value;
                      if (raw === "") {
                        field.onChange(null);
                        return;
                      }
                      const n = Number(raw);
                      // Reject NaN; keep prior value rather than poisoning state.
                      field.onChange(
                        Number.isFinite(n) ? Math.trunc(n) : field.value,
                      );
                    }}
                    onBlur={field.onBlur}
                  />
                </div>
                {/* Indian-locale grouped echo. Example: 10000000 →
                    ₹ 1,00,00,000. Same shared formatter as the tender
                    form and the detail page. */}
                {typeof field.value === "number" && field.value > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {formatInr(field.value)}
                  </p>
                )}
              </div>
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 4: Joint Venture ────────────────────────────────── */}
      <FormSection
        title="Joint venture"
        description="Toggle on if this entry represents a JV between existing companies."
      >
        <FormField
          name="isJv"
          label="Is this a joint venture?"
          error={errors.isJv?.message}
          className="md:col-span-2"
        >
          <Controller
            name="isJv"
            control={control}
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <Switch
                  id="isJv"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={submitDisabled}
                />
                <span className="text-sm text-muted-foreground">
                  {field.value ? "Yes" : "No"}
                </span>
              </div>
            )}
          />
        </FormField>

        {/* Partner picker only renders when isJv is on. */}
        {isJv && (
          <FormField
            name="parentCompanyIds"
            label="Partner companies"
            required
            description="Select at least 2 existing companies that form this joint venture."
            error={errors.parentCompanyIds?.message}
            className="md:col-span-2"
          >
            <Controller
              name="parentCompanyIds"
              control={control}
              render={({ field }) => (
                <PartnerPicker
                  options={existingCompanies}
                  value={field.value ?? []}
                  onChange={field.onChange}
                  disabled={submitDisabled}
                />
              )}
            />
          </FormField>
        )}
      </FormSection>

      {/* Section 5: Contact ──────────────────────────────────────── */}
      <FormSection
        title="Contact"
        description="Primary point of contact for this company."
      >
        <FormField
          name="contactPersonName"
          label="Contact person"
          error={errors.contactPersonName?.message}
        >
          <Input
            type="text"
            placeholder="Full name"
            disabled={submitDisabled}
            {...register("contactPersonName", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="contactEmail"
          label="Email"
          error={errors.contactEmail?.message}
        >
          <Input
            type="email"
            placeholder="contact@example.com"
            disabled={submitDisabled}
            {...register("contactEmail", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="contactPhone"
          label="Phone"
          description="Include country code (e.g. +91 22 5550 1100)"
          error={errors.contactPhone?.message}
          className="md:col-span-2"
        >
          <Input
            type="tel"
            placeholder="+91 ..."
            disabled={submitDisabled}
            {...register("contactPhone", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 6: Address ─────────────────────────────────────── */}
      <FormSection
        title="Address"
        description="Registered office or primary location."
      >
        <FormField
          name="addressLine"
          label="Street address"
          error={errors.addressLine?.message}
          className="md:col-span-2"
        >
          <Input
            type="text"
            placeholder="Plot 14, MIDC Industrial Area"
            disabled={submitDisabled}
            {...register("addressLine", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField name="city" label="City" error={errors.city?.message}>
          <Input
            type="text"
            placeholder="Mumbai"
            disabled={submitDisabled}
            {...register("city", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="state"
          label="State"
          description="Indian state or union territory"
          error={errors.state?.message}
        >
          <Input
            type="text"
            placeholder="Maharashtra"
            disabled={submitDisabled}
            {...register("state", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="pincode"
          label="Pincode"
          description="6-digit postal code"
          error={errors.pincode?.message}
        >
          <Input
            type="text"
            placeholder="400093"
            inputMode="numeric"
            maxLength={6}
            disabled={submitDisabled}
            {...register("pincode", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 7: Internal notes — admin/staff-only field */}
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
            placeholder="Any context worth recording — relationship history, special arrangements, follow-up reminders."
            disabled={submitDisabled}
            {...register("internalNotes", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

      {/* Section 8: Rejection reason — admin/staff, edit-mode, rejected
          companies only. Sits at the bottom of the form because it's
          context for an already-decided state, not part of the
          create / update happy path. The same callout copy appears on
          the detail page header; this is its editable mirror. */}
      {showRejectionReason && (
        <FormSection
          title="Rejection reason"
          description="Why this company was rejected. Visible to Consultway staff only and surfaced on the company detail page header."
          layout="stack"
        >
          <FormField
            name="rejectionReason"
            label="Reason"
            required
            description="Required while the company is in rejected status."
            error={errors.rejectionReason?.message}
          >
            <Textarea
              rows={4}
              placeholder="e.g. Failed background check on directors at intake; commercial dispute under arbitration; regulatory blocker."
              disabled={submitDisabled}
              {...register("rejectionReason", {
                setValueAs: (v) => (v === "" ? null : v),
              })}
            />
          </FormField>
        </FormSection>
      )}

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
              : "Save company"}
        </Button>
      </StickyActionBar>
    </form>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert form values from RHF (where empty inputs are empty strings)
 * to the shape Zod's `createCompanySchema` expects (where optional
 * absent fields are null).
 *
 * `register` with `setValueAs` already does this per-field, but we
 * defensively run it at the form level as well — covers the case where
 * a field is set via Controller (where setValueAs doesn't apply).
 */
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
