"use client";

/**
 * PasswordInput — Input primitive with an inline show/hide toggle.
 *
 * Wraps the shadcn `Input` component, adds a trailing eye-icon button
 * that toggles the type between `password` and `text`. Forwards every
 * other prop straight to the underlying input so `register("password")`
 * from react-hook-form Just Works (the ref, name, onChange, etc. all
 * pass through unchanged).
 *
 * Padding-right is bumped on the input so the toggle icon doesn't sit
 * on top of the typed characters. The button is absolutely positioned
 * over the input's trailing edge, so the toggle stays anchored even
 * inside narrow form layouts.
 *
 * Pattern note: we intentionally do NOT expose a "controlled" reveal
 * prop. The reveal state is local to the input — there's no useful
 * scenario where a parent wants to drive it. Keeps the API tiny.
 *
 * Confirm-password fields should keep using a plain `Input` (no
 * toggle). The whole point of confirm-password is "type it again from
 * memory", and a reveal button defeats that.
 *
 * @module components/ui/password-input
 */
import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type PasswordInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type"
>;

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...props }, ref) {
    const [revealed, setRevealed] = React.useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={revealed ? "text" : "password"}
          // Reserve trailing padding for the toggle so the cursor +
          // typed text never sits under the button.
          className={cn("pr-9", className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide password" : "Show password"}
          aria-pressed={revealed}
          className={cn(
            "absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-muted-foreground transition-colors",
            "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {revealed ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
    );
  },
);

export { PasswordInput };
