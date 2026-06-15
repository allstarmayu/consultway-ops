/**
 * Set-password form (client) — admin invite acceptance.
 *
 * Posts the URL token + chosen password to `acceptInvite`. Honours the
 * action's `{ ok:false, field }` shape: weak-password errors land on the
 * field; an invalid/expired/used token lands on a banner (the token isn't
 * user-editable). On success, routes to `/login?invite=accepted`.
 *
 * Reuses `resetPasswordSchema` — the invite is a "set your initial password"
 * flow with the same token + password-policy shape as a reset.
 *
 * @module app/set-password/_components/set-password-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { AlertCircle } from "lucide-react";
import { acceptInvite } from "@/lib/auth/actions";
import {
  resetPasswordSchema,
  type ResetPasswordInput,
} from "@/lib/auth/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/forms/form-field";

interface Props {
  /** Raw token from the URL. Forwarded as a hidden field. */
  token: string;
}

export function SetPasswordForm({ token }: Props) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ResetPasswordInput>({
    resolver: async (values) => {
      const result = resetPasswordSchema.safeParse(values);
      if (result.success) return { values: result.data, errors: {} };
      const fieldErrors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        if (path && !fieldErrors[path]) {
          fieldErrors[path] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors: fieldErrors };
    },
    defaultValues: { token, newPassword: "" },
  });

  function onSubmit(data: ResetPasswordInput) {
    setServerError(null);
    startTransition(async () => {
      const result = await acceptInvite(data);
      if (!result.ok) {
        if (result.field === "newPassword") {
          setError("newPassword", { type: "server", message: result.error });
        } else {
          setServerError(result.error);
        }
        return;
      }
      router.push("/login?invite=accepted");
    });
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Set your password</CardTitle>
        <CardDescription>
          Welcome to Consultway. Choose a password of at least 10 characters
          with letters and numbers to activate your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {serverError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Couldn&apos;t activate</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          {/* Token is non-editable — wired in from the URL search params. */}
          <input type="hidden" {...register("token")} />

          <FormField
            name="newPassword"
            label="Password"
            required
            error={errors.newPassword?.message}
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...register("newPassword")}
              disabled={isPending}
            />
          </FormField>

          <Button
            type="submit"
            className="w-full"
            disabled={isPending || !token}
            aria-busy={isPending}
          >
            {isPending ? "Activating..." : "Set password and continue"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
