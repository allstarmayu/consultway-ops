/**
 * Transaction form — shared between Create and Edit.
 *
 * Client Component. Owns form state via react-hook-form with the same
 * inline-Zod-resolver pattern as `<ProjectForm>` — avoids
 * `@hookform/resolvers + Zod 4` compatibility issues.
 *
 * Mode is driven by the presence of `initialValues`:
 *
 *   - `initialValues` undefined  → CREATE mode
 *       - calls `createTransaction` Server Action
 *       - validates against `createTransactionSchema`
 *       - redirects to /dashboard/transactions on success
 *
 *   - `initialValues` defined    → EDIT mode
 *       - calls `updateTransaction` Server Action
 *       - `companyId` is NOT mutable post-create — the select is disabled
 *       - validates against `createTransactionSchema` for the form-level
 *         "row after edit must still be valid" check; the server uses
 *         `updateTransactionSchema` (partial) for the actual write
 *
 * Amount input wrinkle: the user types rupees-and-paise (`"12345.67"`)
 * but the schema expects integer paise (`1234567`). The Controller
 * adapts via `parsePaiseFromRupees` / `formatRupeesFromPaise` from
 * `lib/format/inr.ts`.
 *
 * Project select narrows dynamically based on the selected company —
 * a transaction "on" project X for company Y must have Y own X
 * (cross-FK invariant). The action layer enforces this too.
 *
 * @module components/transactions/transaction-form
 */
"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { AlertCircle, Save, X } from "lucide-react";
import {
  createTransaction,
  updateTransaction,
} from "@/lib/transactions/actions";
import {
  createTransactionSchema,
  type CreateTransactionInput,
} from "@/lib/transactions/schemas";
import type { Transaction } from "@/lib/db/schema";
import {
  formatRupeesFromPaise,
  parsePaiseFromRupees,
} from "@/lib/format/inr";
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
import { TRANSACTION_TYPE_OPTIONS } from "@/app/dashboard/transactions/_components/badges";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyOption {
  id: string;
  name: string;
}

export interface ProjectOption {
  id: string;
  name: string;
  companyId: string;
}

export interface TransactionFormProps {
  /** All registered companies — for the counterparty select. */
  companyOptions: CompanyOption[];
  /** All projects across all companies — narrowed by selected company. */
  projectOptions: ProjectOption[];
  /** When present, the form is in EDIT mode. */
  initialValues?: Transaction;
}

// ── Default values ──────────────────────────────────────────────────────────

const CREATE_DEFAULTS: CreateTransactionInput = {
  type: "invoice",
  amountPaise: 0,
  currency: "INR",
  companyId: "",
  projectId: null,
  occurredOn: new Date().toISOString().slice(0, 10),
  referenceNumber: null,
  notes: null,
  internalNotes: null,
};

function buildEditDefaults(t: Transaction): CreateTransactionInput {
  return {
    type: t.type,
    amountPaise: t.amountPaise,
    // Cast: the schema's currency field defaults to literal "INR" and
    // Zod-refuses anything else. The DB column is plain TEXT (kept loose
    // for Phase-3 multi-currency), so the cast bridges the two.
    currency: t.currency as "INR",
    companyId: t.companyId,
    projectId: t.projectId,
    occurredOn: t.occurredOn,
    referenceNumber: t.referenceNumber,
    notes: t.notes,
    internalNotes: t.internalNotes,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export function TransactionForm({
  companyOptions,
  projectOptions,
  initialValues,
}: TransactionFormProps) {
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
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CreateTransactionInput>({
    resolver: async (rawValues) => {
      const values = normaliseFormValues(rawValues);
      const result = createTransactionSchema.safeParse(values);
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

  const selectedCompanyId = watch("companyId");
  const selectedProjectId = watch("projectId");

  // Project select narrows by selected company. When the company
  // changes, clear any project that doesn't belong to the new company.
  const eligibleProjects = useMemo(() => {
    if (!selectedCompanyId) return [];
    return projectOptions.filter((p) => p.companyId === selectedCompanyId);
  }, [selectedCompanyId, projectOptions]);

  function onCompanyChange(next: string) {
    setValue("companyId", next, { shouldDirty: true });
    if (
      selectedProjectId &&
      !projectOptions.find(
        (p) => p.id === selectedProjectId && p.companyId === next,
      )
    ) {
      setValue("projectId", null, { shouldDirty: true });
    }
  }

  function onSubmit(data: CreateTransactionInput) {
    setServerError(null);

    startTransition(async () => {
      const result = isEditMode
        ? await updateTransaction({
            id: initialValues.id,
            type: data.type,
            amountPaise: data.amountPaise,
            currency: data.currency,
            projectId: data.projectId,
            occurredOn: data.occurredOn,
            referenceNumber: data.referenceNumber,
            notes: data.notes,
            internalNotes: data.internalNotes,
          })
        : await createTransaction(data);

      if (!result.ok) {
        if (result.field) {
          setError(result.field as keyof CreateTransactionInput, {
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
          ? `/dashboard/transactions/${initialValues.id}`
          : "/dashboard/transactions",
      );
    });
  }

  const submitDisabled = isSubmitting || isPending;
  const cancelHref = isEditMode
    ? `/dashboard/transactions/${initialValues.id}`
    : "/dashboard/transactions";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isEditMode
              ? "Could not save changes"
              : "Could not save transaction"}
          </AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {/* Section 1: Identity ─────────────────────────────────────── */}
      <FormSection
        title="Identity"
        description="What kind of transaction and how much."
      >
        <FormField
          name="type"
          label="Type"
          required
          error={errors.type?.message}
        >
          <Controller
            name="type"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={submitDisabled}
              >
                <SelectTrigger aria-label="Transaction type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSACTION_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>

        <FormField
          name="amountPaise"
          label="Amount"
          required
          description="Rupees, with optional paise (e.g. 12345.67)."
          error={errors.amountPaise?.message}
        >
          <Controller
            name="amountPaise"
            control={control}
            render={({ field }) => (
              <AmountInput
                valuePaise={field.value}
                onChangePaise={field.onChange}
                onBlur={field.onBlur}
                disabled={submitDisabled}
              />
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 2: Counterparty ─────────────────────────────────── */}
      <FormSection
        title="Counterparty"
        description="The company this transaction is recorded against, and optionally the project it relates to."
      >
        <FormField
          name="companyId"
          label="Company"
          required
          error={errors.companyId?.message}
        >
          <Controller
            name="companyId"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value || undefined}
                onValueChange={onCompanyChange}
                disabled={submitDisabled || isEditMode}
              >
                <SelectTrigger aria-label="Counterparty company">
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
          name="projectId"
          label="Project"
          description="Optional. Leave blank for company-level entries (rent, GST filing fee, etc.)."
          error={errors.projectId?.message}
        >
          <Controller
            name="projectId"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value ?? "__none__"}
                onValueChange={(v) =>
                  field.onChange(v === "__none__" ? null : v)
                }
                disabled={submitDisabled || !selectedCompanyId}
              >
                <SelectTrigger aria-label="Linked project">
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No project</SelectItem>
                  {eligibleProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>
      </FormSection>

      {/* Section 3: Dates ───────────────────────────────────────── */}
      <FormSection
        title="Dates"
        description="The business date the transaction is dated to."
      >
        <FormField
          name="occurredOn"
          label="Date"
          required
          error={errors.occurredOn?.message}
        >
          <Input
            type="date"
            disabled={submitDisabled}
            {...register("occurredOn")}
          />
        </FormField>
      </FormSection>

      {/* Section 4: Reference + notes ───────────────────────────── */}
      <FormSection
        title="Reference & notes"
        description="Invoice number / payment reference, plus any context."
        layout="stack"
      >
        <FormField
          name="referenceNumber"
          label="Reference number"
          description="Optional. Must be unique across all transactions when set."
          error={errors.referenceNumber?.message}
        >
          <Input
            type="text"
            placeholder="INV-2026-014, PAY-77, etc."
            disabled={submitDisabled}
            {...register("referenceNumber", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="notes"
          label="Notes"
          error={errors.notes?.message}
        >
          <Textarea
            rows={3}
            placeholder="Brief context — what this transaction covers."
            disabled={submitDisabled}
            {...register("notes", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>

        <FormField
          name="internalNotes"
          label="Internal notes"
          description="Private to admins."
          error={errors.internalNotes?.message}
        >
          <Textarea
            rows={3}
            disabled={submitDisabled}
            {...register("internalNotes", {
              setValueAs: (v) => (v === "" ? null : v),
            })}
          />
        </FormField>
      </FormSection>

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
              : "Save transaction"}
        </Button>
      </StickyActionBar>
    </form>
  );
}

// ── Amount input ────────────────────────────────────────────────────────────

interface AmountInputProps {
  valuePaise: number;
  onChangePaise: (next: number) => void;
  onBlur: () => void;
  disabled?: boolean;
}

/**
 * Rupees-and-paise text input. Internal value is paise; UI value is a
 * rupees decimal string. The echo line below the input shows the
 * formatted Indian-locale rendering so the user sees exactly what
 * landed.
 */
function AmountInput({
  valuePaise,
  onChangePaise,
  onBlur,
  disabled,
}: AmountInputProps) {
  // Display the rupees-with-decimal representation; user can edit it
  // freely. We don't try to live-format the input value — that would
  // fight the caret. The echo line shows the formatted form.
  const initial = valuePaise > 0 ? (valuePaise / 100).toFixed(2) : "";
  const [text, setText] = useState(initial);

  return (
    <div className="space-y-1">
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
        >
          ₹
        </span>
        <Input
          id="amountPaise"
          type="text"
          inputMode="decimal"
          className="pl-7 font-mono tabular-nums"
          placeholder="0.00"
          disabled={disabled}
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            const parsed = parsePaiseFromRupees(raw);
            onChangePaise(parsed ?? 0);
          }}
          onBlur={onBlur}
        />
      </div>
      {valuePaise > 0 && (
        <p className="text-xs text-muted-foreground">
          {formatRupeesFromPaise(valuePaise)}
        </p>
      )}
    </div>
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
