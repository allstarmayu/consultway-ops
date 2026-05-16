/**
 * useUnsavedChangesGuard — block accidental navigation from a dirty form.
 *
 * When a form has unsaved changes, this hook attaches a `beforeunload`
 * listener so closing the tab, refreshing, or hitting back triggers
 * the browser's native "Leave site?" confirmation. We can't customise
 * the message — modern browsers ignore custom strings for security
 * reasons — but the prompt itself fires.
 *
 * What this hook does NOT catch: client-side `router.push()` navigation
 * (e.g. clicking a sidebar link). Next.js App Router doesn't expose a
 * `router events` API the same way Pages Router did, and the workarounds
 * (intercepting Link clicks, patching pushState) are fragile.
 *
 * For Phase 1, the browser-level guard is adequate — it covers the
 * accidental tab-close / refresh case which is the most common way
 * staff would lose work. Client-side nav lost-work is a follow-up
 * improvement that needs a more careful design.
 *
 * Usage inside a Client Component:
 *
 *   const { formState } = useForm({...});
 *   useUnsavedChangesGuard(formState.isDirty && !formState.isSubmitting);
 *
 * @module components/forms/use-unsaved-changes-guard
 */
"use client";

import { useEffect } from "react";

/**
 * @param enabled When true, attach the beforeunload listener. Pass
 *                a derived boolean — typically `formState.isDirty &&
 *                !formState.isSubmitting`. When false, the listener
 *                detaches and navigation works without prompts.
 */
export function useUnsavedChangesGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    /**
     * The handler MUST call preventDefault and set returnValue for the
     * browser to actually show the prompt. Some browsers also want a
     * non-empty `event.returnValue` string. The string itself isn't
     * shown to the user — browsers display a generic localised message.
     */
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Legacy compat — some browsers require this assignment.
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [enabled]);
}
