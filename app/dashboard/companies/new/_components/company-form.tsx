/**
 * Company create form.
 *
 * Client Component because it owns form state via react-hook-form. The
 * server-side `createCompany` action validates the same Zod schema —
 * client validation is for UX, server validation is authoritative.
 *
 * Architecture:
 *   - One form, one submit. Six visually-sectioned blocks via
 *     `<FormSection>` so the user can mentally chunk progress without
 *     wizard friction.
 *   - Inline Zod resolver (same pattern as login) — avoids the
 *     @hookform/resolvers + Zod 4 compatibility issues.
 *   - On-blur validation per field — surface errors next to the field
 *     the user just left, not in a wall at submit time.
 *   - Sticky action bar at the bottom so Cancel / Save stay reachable
 *     while scrolling.
 *   - Unsaved-changes guard prompts before tab close / refresh.
 *   - On successful submit: navigate to the companies list (detail
 *     page comes in Chunk 6). Uses `router.replace` so the form page
 *     does NOT end up in the browser history — there's no useful "back"
 *     destination from a successfully submitted form.
 *
 * @module app/dashboard/companies/new/_components/company-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { AlertCircle, Save, X } from "lucide-react";
import { createCompany } from "@/lib/companies/actions";
import {
  createCompanySchema,
  type CreateCompanyInput,
} from "@/lib/companies/schemas";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FormSection } from "@/components/forms/form-section";
import { FormField } from "@/components/forms/form-field";
import { StickyActionBar } from "@/components/forms/sticky-action-bar";
import { useUnsavedChangesGuard } from "@/components/forms/use-unsaved-changes-guard";
import { PartnerPicker } from "./partner-picker";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyFormProps {
  /**
   * Existing companies for the JV partner picker typeahead. id+name
   * only — fetched server-side in the parent page.
   */
  existingCompanies: Array<{ id: string; name: string }>;
}

// ── Default values ──────────────────────────────────────────────────────────

/**
 * Hard-coded form defaults so re-renders don't cause uncontrolled→
 * controlled warnings. All optional fields default to empty string so
 * the inputs are controlled from the start; the Zod transform layer
 * converts empty strings to null/undefined before validation.
 */
const DEFAULT_VALUES: CreateCompanyInput = {
  name: "",
  sector: "",
  geography: "",
  gstNumber: null,
  panNumber: null,
  isMsme: false,
  isJv: false,
  parentCompanyIds: null,
  contactEmail: null,
  contactPhone: null,
  contactPersonName: null,
  addressLine: null,
  city: null,
  state: null,
  pincode: null,
  internalNotes: null,
};

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyForm({ existingCompanies }: CompanyFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    control,
    watch,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CreateCompanyInput>({
    /**
     * Inline Zod resolver — `safeParse` on every validate call. Same
     * structure as login: success → values + empty errors; failure →
     * empty values + field-keyed error map.
     *
     * The form fields all have nullable types, but the inputs render
     * empty strings. We pre-process the form values: empty string →
     * null for optional fields, so Zod accepts the partial input.
     */
    resolver: async (rawValues) => {
      // Normalise blanks: optional text fields where the input was
      // never touched come through as "". Zod expects null for those.
      const values = normaliseFormValues(rawValues);

      const result = createCompanySchema.safeParse(values);
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
    defaultValues: DEFAULT_VALUES,
    mode: "onBlur",
  });

  // Block tab close / refresh when form is dirty (and not currently
  // being submitted — we don't want the prompt during the redirect).
  useUnsavedChangesGuard(isDirty && !isSubmitting && !isPending);

  // Watch isJv to conditionally show the partner picker. Watch-pattern
  // here triggers a re-render when the toggle flips, which is what we
  // want for revealing the section.
  const isJv = watch("isJv");

  // ── Submit handler ────────────────────────────────────────────────────────
  //
  // The createCompany call runs inside startTransition so React knows
  // the form is "busy" — this drives the disabled state on the buttons.
  // The redirect is fire-and-forget at the end: router.replace returns
  // void, so the transition function settles, isPending flips back to
  // false, and the navigation happens in the background.
  //
  // Earlier version had `router.refresh()` after `router.push()` inside
  // an `await`-chained block. That kept the transition pending until
  // BOTH the RSC payload AND the refresh resolved, which in dev was
  // long enough to leave the form visually stuck on "Saving..." even
  // though the server had long since responded. router.replace alone
  // is enough — the destination page re-fetches its own data on mount.

  function onSubmit(data: CreateCompanyInput) {
    setServerError(null);
    startTransition(async () => {
      const result = await createCompany(data);

      if (!result.ok) {
        // Field-targeted error → highlight the offending input.
        if (result.field) {
          setError(result.field as keyof CreateCompanyInput, {
            type: "server",
            message: result.error,
          });
        } else {
          setServerError(result.error);
        }
        return;
      }

      // Success. Detail page lands in a later chunk; for now go to the
      // list. `replace` (not `push`) so the form page doesn't pollute
      // browser history — there's no useful "back" after a successful
      // submission.
      router.replace("/dashboard/companies");
    });
  }

  const submitDisabled = isSubmitting || isPending;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {/* Top-of-form server error banner. Field errors render inline. */}
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not save company</AlertTitle>
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

      {/* Section 3: Joint Venture ────────────────────────────────── */}
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

        {/* Partner picker only renders when isJv is on. Animating in
            would be nicer but adds complexity; clean conditional is
            fine for Phase 1. */}
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

      {/* Section 4: Contact ──────────────────────────────────────── */}
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

      {/* Section 5: Address ─────────────────────────────────────── */}
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

        <FormField
          name="city"
          label="City"
          error={errors.city?.message}
        >
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

      {/* Section 6: Internal notes — admin/staff-only field */}
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
          onClick={() => router.push("/dashboard/companies")}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          <Save className="h-4 w-4" aria-hidden />
          {submitDisabled ? "Saving..." : "Save company"}
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
