/**
 * FormField — reusable wrapper around a single labelled form input.
 *
 * Replaces the inline `<Label>` + `<Input>` + `<p role="alert">` triplet
 * that the login page currently does manually. Every form in the app
 * should use this so spacing, error display, label-input association,
 * and screen-reader hooks are consistent everywhere.
 *
 * Usage:
 *
 *   <FormField
 *     name="email"
 *     label="Email"
 *     required
 *     description="We'll use this for compliance reminders."
 *     error={errors.email?.message}
 *   >
 *     <Input type="email" {...register("email")} />
 *   </FormField>
 *
 * The `name` prop drives:
 *   - `htmlFor` on the label
 *   - `id` on the input (via React.cloneElement, see implementation)
 *   - `aria-describedby` linkage to description + error
 *
 * @module components/forms/form-field
 */
import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

// ── Props ───────────────────────────────────────────────────────────────────

export interface FormFieldProps {
  /**
   * Field identifier. Used for `htmlFor`, child `id`, and aria linkages.
   * Should match the field name in your form schema for consistency.
   */
  name: string;

  /** Visible label text. */
  label: string;

  /** Mark with a subtle asterisk if true. Required-ness is enforced by
   *  the Zod schema, not this prop — the asterisk is purely visual. */
  required?: boolean;

  /** Optional hint shown below the label, above the input. */
  description?: string;

  /** Optional error message — typically `errors.fieldName?.message`
   *  from react-hook-form. Renders below the input in destructive style. */
  error?: string;

  /** The actual input element (Input, Select, Textarea, Switch, etc.). */
  children: React.ReactNode;

  /** Extra classes for the outer wrapper. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function FormField({
  name,
  label,
  required,
  description,
  error,
  children,
  className,
}: FormFieldProps) {
  const descriptionId = description ? `${name}-description` : undefined;
  const errorId = error ? `${name}-error` : undefined;

  // ARIA: link the input to its description and error via space-joined IDs.
  // React.cloneElement injects id + aria-* props onto whatever the caller
  // passed as `children`. This means callers don't have to repeat the id
  // or aria attrs every time — they just pass the component.
  const enhancedChild = React.isValidElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>(children)
    ? React.cloneElement(children, {
        id: children.props.id ?? name,
        "aria-describedby":
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : undefined,
      })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label
        htmlFor={name}
        className="flex items-center gap-1 text-sm font-medium text-foreground"
      >
        {label}
        {required && (
          <span
            aria-hidden
            className="text-destructive"
            title="Required field"
          >
            *
          </span>
        )}
      </Label>

      {description && !error && (
        <p
          id={descriptionId}
          className="text-xs text-muted-foreground"
        >
          {description}
        </p>
      )}

      {enhancedChild}

      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertCircle
            className="mt-0.5 h-3 w-3 shrink-0"
            aria-hidden
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
