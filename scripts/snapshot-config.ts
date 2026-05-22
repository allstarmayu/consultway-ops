// scripts/snapshot-config.ts
/**
 * Declarative config for `scripts/snapshot.ts`.
 *
 * Edit this file (not the generator) when:
 *   - A new pattern emerges and a canonical example file changes
 *   - A new domain module joins the curated set
 *   - A formerly small file grows past the embed threshold and should
 *     be referenced rather than embedded
 *
 * Paths use POSIX forward slashes and are RELATIVE to the project root.
 * They must match `git ls-files` output exactly.
 *
 * @module scripts/snapshot-config
 */

/** A single curated section of `docs/key-files-snapshot.md`. */
export interface CuratedSection {
  /** Section heading text. */
  title: string;
  /** Prose under the heading — explains why these files were picked. */
  intro: string;
  /** Files to embed in full, in the order they should appear. */
  files: string[];
}

/**
 * The curated file groups, in the order they'll appear in
 * `docs/key-files-snapshot.md`.
 *
 * Principle: one canonical example per pattern. Read the matching
 * `intro` to see why a particular file was picked over its siblings.
 */
export const CURATED_SECTIONS: CuratedSection[] = [
  {
    title: "Core Foundations",
    intro:
      "These are the files imported by almost every feature. Touch with care — a change here ripples across the codebase.",
    files: [
      ".env.example",
      "lib/env.ts",
      "lib/logger.ts",
      "lib/utils.ts",
      "lib/db/index.ts",
      "lib/db/ids.ts",
      "lib/db/schema.ts",
    ],
  },
  {
    title: "Authentication",
    intro:
      "JWT session helpers, the login/logout Server Actions, password hashing, and the Zod schemas that validate credentials. RBAC is enforced inside session helpers — see `requireRole`.",
    files: [
      "lib/auth/session.ts",
      "lib/auth/actions.ts",
      "lib/auth/password.ts",
      "lib/auth/schemas.ts",
    ],
  },
  {
    title: "Audit Log",
    intro:
      "Every privileged mutation should record an entry here. See how `lib/companies/actions.ts` calls into this module from each Server Action. The `audit_log` table was persisted to D1 in day 5 — `listAuditEvents` is the read API.",
    files: [
      "lib/audit/log.ts",
      "lib/audit/schemas.ts",
    ],
  },
  {
    title: "Server Action Pattern — Reference Implementation",
    intro:
      "The canonical example of how a domain module is structured: a `schemas.ts` with Zod validators, an `actions.ts` with Server Actions that follow the `validate → RBAC check → DB write → audit log → revalidate → return typed result` sequence. Mirror this layout for new modules. `lib/tenders/actions.ts` follows the same pattern but is ~1,900 lines and is omitted here to keep this snapshot focused — read it directly when needed.",
    files: [
      "lib/companies/schemas.ts",
      "lib/companies/actions.ts",
      "lib/tenders/schemas.ts",
      "lib/tenders/state-machine.ts",
    ],
  },
  {
    title: "Form Primitives",
    intro:
      "All domain forms compose these. Never reinvent — extend if a new primitive is needed and add it under `components/forms/`.",
    files: [
      "components/forms/form-field.tsx",
      "components/forms/form-section.tsx",
      "components/forms/sticky-action-bar.tsx",
      "components/forms/use-unsaved-changes-guard.ts",
    ],
  },
  {
    title: "Domain Form — Reference Implementation",
    intro:
      "How a real form ties together: Server Action handling, optimistic UI, unsaved-changes guard, sticky action bar. `components/tenders/tender-form.tsx` follows the same pattern and is omitted here.",
    files: ["components/companies/company-form.tsx"],
  },
  {
    title: "Dialogs and Confirmation UI",
    intro:
      "Reuse these — do not import a new dialog library. `confirm-dialog.tsx` supports reason capture (added in day 5) for actions that need a written rationale.",
    files: [
      "components/ui/confirm-dialog.tsx",
      "components/ui/alert-dialog.tsx",
      "components/ui/alert.tsx",
    ],
  },
  {
    title: "Table + Pagination Primitives",
    intro:
      "List screens follow a fixed shape: page server-component reads filters from `searchParams` → calls a Drizzle query → renders the table + filters-bar + pagination. Use these primitives; see the companies list in the next section for the wiring.",
    files: [
      "components/ui/table.tsx",
      "components/dashboard/pagination.tsx",
      "components/dashboard/page-header.tsx",
    ],
  },
  {
    title: "Dashboard Shell",
    intro:
      "The shell every authenticated route renders inside. The sidebar handles role-aware navigation; do not duplicate that logic per page.",
    files: [
      "app/layout.tsx",
      "app/dashboard/layout.tsx",
      "components/dashboard/sidebar.tsx",
      "components/dashboard/user-pill.tsx",
    ],
  },
  {
    title: "List + Detail Page Pattern — Reference Implementation",
    intro:
      "The companies module is the cleanest reference for: list page with searchParams-driven filtering, detail page with overview + header, edit/delete sub-routes, and the matching `_components` colocated layout.",
    files: [
      "app/dashboard/companies/page.tsx",
      "app/dashboard/companies/_components/filters-bar.tsx",
      "app/dashboard/companies/_components/companies-table.tsx",
      "app/dashboard/companies/_components/badges.tsx",
      "app/dashboard/companies/[id]/page.tsx",
      "app/dashboard/companies/[id]/_components/company-header.tsx",
      "app/dashboard/companies/[id]/_components/company-overview.tsx",
      "app/dashboard/companies/loading.tsx",
      "app/dashboard/companies/error.tsx",
      "app/dashboard/companies/[id]/not-found.tsx",
    ],
  },
  {
    title: "Auth Pages",
    intro:
      "The login screen, the root entry point, and the edge proxy that gates dashboard routes. The root page redirects to dashboard or login based on session state.",
    files: ["app/page.tsx", "app/login/page.tsx", "proxy.ts"],
  },
  {
    title: "Config",
    intro:
      "Project-wide config. Read these before changing tooling, deploy targets, or path aliases.",
    files: [
      "package.json",
      "tsconfig.json",
      "next.config.ts",
      "wrangler.jsonc",
      "drizzle.config.ts",
      "components.json",
    ],
  },
];

/**
 * Files in the project tree that exist but are intentionally omitted
 * from the curated snapshot. Listed at the bottom of
 * `docs/key-files-snapshot.md` so readers know what's missing and why.
 *
 * Keep this in sync with `CURATED_SECTIONS` — when you add a file to a
 * section, remove it from here if it was previously excluded.
 */
export const EXPLICITLY_EXCLUDED: Array<{ path: string; reason: string }> = [
  {
    path: "lib/tenders/actions.ts",
    reason:
      "~1,900 lines. Same Server Action pattern as `lib/companies/actions.ts` plus state-machine transitions (which are isolated in `lib/tenders/state-machine.ts`, included above).",
  },
  {
    path: "components/tenders/tender-form.tsx",
    reason: "Same pattern as `components/companies/company-form.tsx`.",
  },
  {
    path: "app/dashboard/tenders/**",
    reason:
      "List/detail/edit/delete pages mirror the companies module structure shown above.",
  },
  {
    path: "app/dashboard/page.tsx",
    reason:
      "Dashboard home, mostly KPI cards. Ask for contents if editing.",
  },
  {
    path: "app/globals.css",
    reason:
      "Tailwind layer setup and palette CSS variables. Treated as generated config; consult `docs/07-design-system.md` and `docs/design/palette/` instead.",
  },
  {
    path: "drizzle/*.sql and drizzle/meta/*.json",
    reason:
      "Auto-generated migrations. `lib/db/schema.ts` (above) is the source of truth.",
  },
  {
    path: "components/ui/{button,input,label,select,card,checkbox,switch,textarea}.tsx",
    reason:
      "Untouched shadcn primitives. Read `components.json` to see what's installed; consult the file directly only when modifying it.",
  },
  {
    path: "scripts/seed.ts and scripts/snapshot.ts",
    reason: "Tooling, not production code.",
  },
];

/**
 * Top-level directories considered "code dirs" for the project-tree
 * summary table. Anything not in this list and not at the repo root
 * falls into the "other" bucket.
 */
export const CODE_DIRECTORIES = [
  "app",
  "components",
  "lib",
  "drizzle",
  "docs",
  "scripts",
  "public",
] as const;

/**
 * File globs (POSIX) that are tracked by git but excluded from
 * `docs/project-tree.md`. Binaries and lockfiles produce no useful
 * tree-level signal.
 */
export const TREE_EXCLUDE_PATTERNS: RegExp[] = [
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|woff2?|ttf|eot)$/i,
  /^pnpm-lock\.yaml$/,
];
