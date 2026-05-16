/**
 * FormSection — visual grouping for a related batch of form fields.
 *
 * Every form in the app divides its fields into sections (Identity,
 * Compliance, Contact, etc.). This component keeps the section header
 * styling, spacing, and divider treatment consistent across the whole
 * app.
 *
 * Usage:
 *
 *   <FormSection
 *     title="Identity"
 *     description="Basic information about the company."
 *   >
 *     <FormField name="name" label="Company name" required>...</FormField>
 *     <FormField name="sector" label="Sector" required>...</FormField>
 *   </FormSection>
 *
 * Sections render as: title (h2) + optional one-line description, then
 * a responsive grid of children. Single-column on mobile, 2-column from
 * `md:` up.
 *
 * @module components/forms/form-section
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface FormSectionProps {
  /** Section heading shown above the fields. */
  title: string;

  /** Optional one-line description shown muted below the title. */
  description?: string;

  /** The fields inside this section. Typically several `<FormField>`s. */
  children: ReactNode;

  /**
   * Layout for the children grid:
   *   - "grid" (default) — 1 column mobile, 2 columns md+
   *   - "stack" — always 1 column (use for full-width fields like
   *     textarea, address line, internal notes)
   */
  layout?: "grid" | "stack";

  /** Extra classes for the section wrapper. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function FormSection({
  title,
  description,
  children,
  layout = "grid",
  className,
}: FormSectionProps) {
  return (
    <section
      className={cn(
        // Each section gets a top border for visual separation, except
        // the first one — `first:border-t-0` neutralises it when this
        // is the first section in a form.
        "border-t border-border pt-6 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <header className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </header>

      <div
        className={cn(
          "gap-4",
          layout === "grid"
            ? "grid grid-cols-1 md:grid-cols-2"
            : "flex flex-col",
        )}
      >
        {children}
      </div>
    </section>
  );
}
