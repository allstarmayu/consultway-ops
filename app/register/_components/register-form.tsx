/**
 * RegisterForm — client-side single-page registration form.
 *
 * Mirrors the login form's inline-Zod-resolver pattern (Zod 4 + RHF
 * compatibility shim) and the company-form's `<FormField>` + section
 * conventions. Single page — multi-step UX is deferred per Day-15
 * out-of-scope.
 *
 * On success the form pushes to `/register/check-email?email=<encoded>`
 * — Chunk 2 fills out that page with the verification-link copy and
 * resend button. For Chunk 1 the redirect just lands on a static
 * placeholder.
 *
 * @module app/register/_components/register-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { AlertCircle } from "lucide-react";
import { registerCompany } from "@/lib/auth/actions";
import {
  registerCompanySchema,
  type RegisterCompanyInput,
} from "@/lib/auth/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/forms/form-field";
import { FormSection } from "@/components/forms/form-section";

// Form's UI defaults. `acceptedTerms` defaults to false (the schema
// enforces literal true at submit — RHF renders an unchecked Checkbox
// from this value).
//
// `userEmail` defaults to an empty string so the inline resolver's
// "blank means defer to contactEmail" behaviour kicks in cleanly.
type FormValues = Omit<RegisterCompanyInput, "acceptedTerms"> & {
  acceptedTerms: boolean;
};

const DEFAULTS: FormValues = {
  companyName: "",
  sector: "",
  geography: "",
  gstNumber: null,
  panNumber: null,
  contactPersonName: "",
  contactPhone: "",
  contactEmail: "",
  userName: "",
  userEmail: "",
  password: "",
  acceptedTerms: false,
};

export function RegisterForm() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    /**
     * Inline resolver — same shape as the login page's. Avoids the
     * @hookform/resolvers + Zod 4 compatibility split.
     */
    resolver: async (values) => {
      // Normalise empty strings to null on optional GST/PAN before Zod
      // sees them — the schema accepts null but the form's <Input> hands
      // back "" when the user leaves it blank.
      const normalised = {
        ...values,
        gstNumber: values.gstNumber === "" ? null : values.gstNumber,
        panNumber: values.panNumber === "" ? null : values.panNumber,
      };
      const result = registerCompanySchema.safeParse(normalised);
      if (result.success) {
        return { values: result.data, errors: {} };
      }
      const fieldErrors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        if (path && !fieldErrors[path]) {
          fieldErrors[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors: fieldErrors };
    },
    defaultValues: DEFAULTS,
    mode: "onBlur",
  });

  function onSubmit(values: FormValues) {
    setServerError(null);
    startTransition(async () => {
      const result = await registerCompany(values);
      if (!result.ok) {
        if (result.field) {
          setError(result.field as keyof FormValues, {
            type: "server",
            message: result.error,
          });
        } else {
          setServerError(result.error);
        }
        return;
      }
      // Forward the user email so the check-email page can echo it.
      // userEmail was normalised by the schema's transform — for redirect
      // we use whatever the form posted, falling back to contactEmail.
      const echo = values.userEmail || values.contactEmail;
      router.push(`/register/check-email?email=${encodeURIComponent(echo)}`);
    });
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Register your company</CardTitle>
        <CardDescription>
          Create the company profile and your administrator account in one
          step. We&apos;ll send a verification link before you can sign in.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-8" noValidate>
          {serverError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Registration failed</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          <FormSection
            title="Company"
            description="Details about the organisation you're registering."
            layout="stack"
          >
            <FormField
              name="companyName"
              label="Company name"
              required
              error={errors.companyName?.message}
            >
              <Input
                {...register("companyName")}
                placeholder="Acme Construction Pvt Ltd"
                disabled={isPending}
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="sector"
                label="Sector"
                required
                description="e.g. Infrastructure, Solar EPC, Civil Works"
                error={errors.sector?.message}
              >
                <Input {...register("sector")} disabled={isPending} />
              </FormField>

              <FormField
                name="geography"
                label="Geography"
                required
                description="e.g. Maharashtra, Pan India"
                error={errors.geography?.message}
              >
                <Input {...register("geography")} disabled={isPending} />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="gstNumber"
                label="GST number"
                description="Optional - leave blank if not yet registered"
                error={errors.gstNumber?.message}
              >
                <Input
                  {...register("gstNumber")}
                  placeholder="22AAAAA0000A1Z5"
                  disabled={isPending}
                />
              </FormField>

              <FormField
                name="panNumber"
                label="PAN"
                description="Optional"
                error={errors.panNumber?.message}
              >
                <Input
                  {...register("panNumber")}
                  placeholder="ABCDE1234F"
                  disabled={isPending}
                />
              </FormField>
            </div>
          </FormSection>

          <FormSection
            title="Primary contact"
            description="Who should Consultway staff reach about this company?"
            layout="stack"
          >
            <FormField
              name="contactPersonName"
              label="Contact person"
              required
              error={errors.contactPersonName?.message}
            >
              <Input
                {...register("contactPersonName")}
                disabled={isPending}
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="contactEmail"
                label="Contact email"
                required
                error={errors.contactEmail?.message}
              >
                <Input
                  type="email"
                  autoComplete="email"
                  {...register("contactEmail")}
                  disabled={isPending}
                />
              </FormField>

              <FormField
                name="contactPhone"
                label="Contact phone"
                required
                error={errors.contactPhone?.message}
              >
                <Input
                  type="tel"
                  autoComplete="tel"
                  {...register("contactPhone")}
                  disabled={isPending}
                />
              </FormField>
            </div>
          </FormSection>

          <FormSection
            title="Your account"
            description="The administrator login for your company workspace."
            layout="stack"
          >
            <FormField
              name="userName"
              label="Your name"
              required
              error={errors.userName?.message}
            >
              <Input
                {...register("userName")}
                autoComplete="name"
                disabled={isPending}
              />
            </FormField>

            <FormField
              name="userEmail"
              label="Login email"
              description="Defaults to the contact email above if left blank."
              error={errors.userEmail?.message}
            >
              <Input
                type="email"
                autoComplete="email"
                {...register("userEmail")}
                disabled={isPending}
              />
            </FormField>

            <FormField
              name="password"
              label="Password"
              required
              description="At least 10 characters, with letters and numbers."
              error={errors.password?.message}
            >
              <Input
                type="password"
                autoComplete="new-password"
                {...register("password")}
                disabled={isPending}
              />
            </FormField>
          </FormSection>

          <div className="space-y-2">
            <label className="flex items-start gap-3 text-sm">
              {/* Native checkbox so react-hook-form's register() can bind
                  the checked state cleanly. The radix <Checkbox> uses
                  onCheckedChange instead of onChange and would need a
                  Controller wrapper — not worth it for a single field. */}
              <input
                type="checkbox"
                {...register("acceptedTerms")}
                disabled={isPending}
                aria-invalid={!!errors.acceptedTerms}
                className="mt-0.5 size-4 rounded border-input accent-primary"
              />
              <span>
                I have read and accept the Consultway terms of service and
                privacy notice.
              </span>
            </label>
            {errors.acceptedTerms && (
              <p
                role="alert"
                className="flex items-start gap-1.5 text-xs text-destructive"
              >
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span>{errors.acceptedTerms.message}</span>
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
