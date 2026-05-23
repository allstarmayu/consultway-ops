/**
 * Reset-password form (client).
 *
 * Posts the URL token + chosen new password to `resetPassword`. Honours
 * the action's `{ ok:false, field }` shape for surfacing per-field errors
 * (e.g. the "link no longer valid" branch lands on `field: 'token'`).
 *
 * @module app/reset-password/_components/reset-password-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { AlertCircle } from "lucide-react";
import { resetPassword } from "@/lib/auth/actions";
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

export function ResetPasswordForm({ token }: Props) {
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
      const result = await resetPassword(data);
      if (!result.ok) {
        if (result.field === "newPassword") {
          setError("newPassword", { type: "server", message: result.error });
        } else {
          // token / unknown -> banner error, the token isn't user-editable
          setServerError(result.error);
        }
        return;
      }
      router.push("/login?reset=success");
    });
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Choose a new password</CardTitle>
        <CardDescription>
          Enter a new password of at least 10 characters with letters and
          numbers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          {serverError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Couldn&apos;t reset</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          {/* Token is non-editable — wired in from the URL search params. */}
          <input type="hidden" {...register("token")} />

          <FormField
            name="newPassword"
            label="New password"
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
            {isPending ? "Saving..." : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
