/**
 * Dashboard template — wraps every /dashboard/* page render in a soft
 * cross-fade so navigating between sections (Companies → Tenders, etc.)
 * doesn't feel like a hard cut.
 *
 * Why `template.tsx` and not `layout.tsx`:
 *   - A `layout` is preserved across navigations between sibling
 *     segments, so it doesn't re-render when the route changes — which
 *     is exactly why putting the transition there wouldn't fire.
 *   - A `template` is the opposite: re-mounts on every route change,
 *     including same-segment param changes. That re-mount is the trigger
 *     for our framer-motion entry animation.
 *   - Filter / pagination changes in the list pages mutate `searchParams`
 *     on the same route, which does NOT re-trigger the template — so
 *     filtering Companies doesn't cause a full-page fade, only crossing
 *     into a new section does. This is the desired UX.
 *
 * Why framer-motion and not the View Transitions API:
 *   - Next.js 16's built-in View Transitions support is still gated
 *     behind a flag and has cross-browser issues on Firefox.
 *   - `motion` is already a dependency (Day 25 Settings work) — no new
 *     bundle weight.
 *   - The animation is intentionally restrained (200ms, 6px y-offset,
 *     soft ease) so it complements the existing Settings-internal
 *     section transitions rather than competing with them. The two
 *     layers stack: template-level fade on route change, framer
 *     AnimatePresence inside Settings for cross-section.
 *
 * Reduced motion: the global `prefers-reduced-motion` media query in
 * globals.css collapses CSS animations and transitions, but framer-
 * motion uses inline transforms that aren't governed by that rule.
 * Pulling in `useReducedMotion()` here lets us drop the animation
 * cleanly when the user (or their OS) has the preference set.
 *
 * @module app/dashboard/template
 */
"use client";

import { motion, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";

export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion();
  const pathname = usePathname();

  if (prefersReducedMotion) {
    // Skip the animation wrapper entirely — keeps the DOM and react
    // tree shallower for users who don't want motion.
    return <>{children}</>;
  }

  // Keying on `pathname` (not on the template's natural identity) makes
  // the entry animation fire only on a real route change, never on
  // filter / search-param updates within the same segment. Belt-and-
  // suspenders: Next's template semantics already do this, but pinning
  // the React key makes it explicit and survives any future framework
  // semantics shifts.
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
