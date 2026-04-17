/**
 * Login page — the first interactive UI in the portal.
 *
 * Client component because it uses react-hook-form. The form posts to
 * the `login` Server Action in lib/auth/actions.ts, which on success
 * issues a session cookie and redirects to /dashboard.
 *
 * Why an inline resolver instead of @hookform/resolvers?
 *   As of @hookform/resolvers@5.2.2, neither `zodResolver` nor
 *   `standardSchemaResolver` cleanly accept Zod 4.x schemas — the
 *   former has type incompatibilities, the latter fails at runtime
 *   trying to read a `.validate` method Zod doesn't expose by that
 *   name. Rather than pin to an older resolver version or Zod 3,
 *   we run `loginSchema.safeParse()` directly in a ~10-line
 *   resolver function. Zero library coupling, identical behavior.
 *
 * @module app/login
 */
"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { AlertCircle, Building2 } from "lucide-react";
import Link from "next/link";
import { login } from "@/lib/auth/actions";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
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
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    /**
     * Inline resolver: turn Zod's safeParse result into RHF's expected
     * `{ values, errors }` shape. Avoids the whole @hookform/resolvers
     * compatibility situation with Zod 4.
     */
    resolver: async (values) => {
      const result = loginSchema.safeParse(values);
      if (result.success) {
        return { values: result.data, errors: {} };
      }
      const errors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        // First error per field wins (standard RHF behavior).
        if (path && !errors[path]) {
          errors[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors };
    },
    defaultValues: { email: "", password: "" },
  });

  function onSubmit(data: LoginInput) {
    setServerError(null);
    startTransition(async () => {
      const result = await login(data);
      // On success, the action redirects — we never reach this line.
      // On failure, result has `{ ok: false, error }`.
      if (!result.ok) {
        setServerError(result.error);
      }
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-6 py-12">
      <div className="w-full max-w-md">
        {/* Brand header */}
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-3"
          aria-label="Consultway Infotech home"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <Building2
              className="h-5 w-5 text-primary-foreground"
              aria-hidden
            />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Consultway Ops
          </span>
        </Link>

        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl">Sign in</CardTitle>
            <CardDescription>
              Use your Consultway credentials to access the portal.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form
              onSubmit={handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              {/* Server-side / credential error */}
              {serverError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Sign-in failed</AlertTitle>
                  <AlertDescription>{serverError}</AlertDescription>
                </Alert>
              )}

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@consultway.local"
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  disabled={isPending}
                  {...register("email")}
                />
                {errors.email && (
                  <p
                    id="email-error"
                    className="text-sm text-destructive"
                    role="alert"
                  >
                    {errors.email.message}
                  </p>
                )}
              </div>

              {/* Password */}
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={!!errors.password}
                  aria-describedby={
                    errors.password ? "password-error" : undefined
                  }
                  disabled={isPending}
                  {...register("password")}
                />
                {errors.password && (
                  <p
                    id="password-error"
                    className="text-sm text-destructive"
                    role="alert"
                  >
                    {errors.password.message}
                  </p>
                )}
              </div>

              {/* Submit */}
              <Button
                type="submit"
                className="w-full"
                disabled={isPending}
                aria-busy={isPending}
              >
                {isPending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Footer note */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Internal portal · Not for public use
        </p>
      </div>
    </main>
  );
}
