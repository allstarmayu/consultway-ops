# Project Tree

> **_AUTO-GENERATED — DO NOT EDIT._** Regenerate via `pnpm snapshot`.

_Last generated: 2026-05-22_

Current file inventory for the Consultway Ops internal platform (**141 files** tracked by git, excluding binaries and lockfiles). Derived from `git ls-files` — always matches HEAD.

Use this for orientation only. **For file contents, see `docs/key-files-snapshot.md` (curated).** When this file disagrees with what is actually on disk, regenerate.

---

## Summary

| Area | Files |
|---|---|
| `app/` | 42 |
| `components/` | 26 |
| `lib/` | 21 |
| `drizzle/` | 11 |
| `docs/` | 21 |
| `scripts/` | 3 |
| _root_ | 17 |
| **Total** | **141** |

## Quick Orientation

- **`app/`** — Next.js App Router. Route segments mirror URL structure; every route folder may have a `_components/` for colocated UI, plus `loading.tsx`, `error.tsx`, and `not-found.tsx` where useful.
- **`components/`** — Cross-route UI. `ui/` holds shadcn primitives, `forms/` holds form scaffolding, `dashboard/` holds shell components, and domain folders (`companies/`, `tenders/`) hold shared domain forms.
- **`lib/`** — Server-side modules. Each domain has its own folder with `actions.ts` (Server Actions) and `schemas.ts` (Zod). `db/`, `auth/`, `audit/` are cross-cutting.
- **`drizzle/`** — Generated migrations + meta. Source of truth is `lib/db/schema.ts`.
- **`docs/`** — Authoritative project documentation.
- **`scripts/`** — Tooling: `seed.ts` and `snapshot.ts`.

---

## Full Tree

### Root

```
.env.example
.gitattributes
.gitignore
AGENTS.md
CLAUDE.md
CONTRIBUTING.md
README.md
components.json
drizzle.config.ts
eslint.config.mjs
next.config.ts
package.json
pnpm-workspace.yaml
postcss.config.mjs
proxy.ts
tsconfig.json
wrangler.jsonc
```

### `app/`

_42 files_

```
app/
├── dashboard/
│   ├── _components/
│   │   ├── activity-feed-loading.tsx
│   │   └── activity-feed.tsx
│   ├── companies/
│   │   ├── [id]/
│   │   │   ├── _components/
│   │   │   │   ├── company-header.tsx
│   │   │   │   └── company-overview.tsx
│   │   │   ├── delete/
│   │   │   │   ├── _components/
│   │   │   │   │   └── delete-form.tsx
│   │   │   │   └── page.tsx
│   │   │   ├── edit/
│   │   │   │   └── page.tsx
│   │   │   ├── loading.tsx
│   │   │   ├── not-found.tsx
│   │   │   └── page.tsx
│   │   ├── _components/
│   │   │   ├── badges.tsx
│   │   │   ├── companies-table.tsx
│   │   │   └── filters-bar.tsx
│   │   ├── new/
│   │   │   ├── _components/
│   │   │   │   └── partner-picker.tsx
│   │   │   └── page.tsx
│   │   ├── error.tsx
│   │   ├── loading.tsx
│   │   └── page.tsx
│   ├── tenders/
│   │   ├── [id]/
│   │   │   ├── _components/
│   │   │   │   ├── applications-table.tsx
│   │   │   │   ├── apply-button.tsx
│   │   │   │   ├── tender-header.tsx
│   │   │   │   └── tender-overview.tsx
│   │   │   ├── delete/
│   │   │   │   ├── _components/
│   │   │   │   │   └── delete-form.tsx
│   │   │   │   └── page.tsx
│   │   │   ├── edit/
│   │   │   │   └── page.tsx
│   │   │   ├── loading.tsx
│   │   │   ├── not-found.tsx
│   │   │   └── page.tsx
│   │   ├── _components/
│   │   │   ├── badges.tsx
│   │   │   ├── filters-bar.tsx
│   │   │   └── tenders-table.tsx
│   │   ├── new/
│   │   │   ├── loading.tsx
│   │   │   └── page.tsx
│   │   ├── error.tsx
│   │   ├── loading.tsx
│   │   └── page.tsx
│   ├── layout.tsx
│   └── page.tsx
├── login/
│   └── page.tsx
├── globals.css
├── layout.tsx
└── page.tsx
```

### `components/`

_26 files_

```
components/
├── audit/
│   ├── activity-feed-empty.tsx
│   ├── activity-feed-row.tsx
│   ├── entity-history-loading.tsx
│   └── entity-history.tsx
├── companies/
│   └── company-form.tsx
├── dashboard/
│   ├── page-header.tsx
│   ├── pagination.tsx
│   ├── sidebar.tsx
│   └── user-pill.tsx
├── forms/
│   ├── form-field.tsx
│   ├── form-section.tsx
│   ├── sticky-action-bar.tsx
│   └── use-unsaved-changes-guard.ts
├── tenders/
│   └── tender-form.tsx
└── ui/
    ├── alert-dialog.tsx
    ├── alert.tsx
    ├── button.tsx
    ├── card.tsx
    ├── checkbox.tsx
    ├── confirm-dialog.tsx
    ├── input.tsx
    ├── label.tsx
    ├── select.tsx
    ├── switch.tsx
    ├── table.tsx
    └── textarea.tsx
```

### `lib/`

_21 files_

```
lib/
├── audit/
│   ├── diff.ts
│   ├── labels.ts
│   ├── log.ts
│   ├── resolve-targets.ts
│   └── schemas.ts
├── auth/
│   ├── actions.ts
│   ├── password.ts
│   ├── schemas.ts
│   └── session.ts
├── companies/
│   ├── actions.ts
│   └── schemas.ts
├── db/
│   ├── ids.ts
│   ├── index.ts
│   └── schema.ts
├── tenders/
│   ├── actions.ts
│   ├── schemas.ts
│   └── state-machine.ts
├── utils/
│   └── format-relative-time.ts
├── env.ts
├── logger.ts
└── utils.ts
```

### `drizzle/`

_11 files_

```
drizzle/
├── meta/
│   ├── 0000_snapshot.json
│   ├── 0001_snapshot.json
│   ├── 0002_snapshot.json
│   ├── 0003_snapshot.json
│   ├── 0004_snapshot.json
│   └── _journal.json
├── 0000_wild_wendell_rand.sql
├── 0001_loving_serpent_society.sql
├── 0002_peaceful_blizzard.sql
├── 0003_elite_gambit.sql
└── 0004_familiar_marvel_zombies.sql
```

### `docs/`

_21 files_

```
docs/
├── design/
│   ├── logo/
│   │   └── README.md
│   ├── palette/
│   │   └── README.md
│   └── README.md
├── reports/
│   ├── day-3-report.md
│   ├── day-4-report.md
│   ├── day-5-report.md
│   └── day-6-report.md
├── 01-project-brief.md
├── 02-tech-stack.md
├── 03-development-phases.md
├── 04-architecture.md
├── 05-database-schema.md
├── 06-api-reference.md
├── 07-design-system.md
├── 08-rbac-matrix.md
├── 09-deployment.md
├── 10-local-setup.md
├── 11-coding-standards.md
├── 12-testing.md
├── key-files-snapshot.md
└── project-tree.md
```

### `scripts/`

_3 files_

```
scripts/
├── seed.ts
├── snapshot-config.ts
└── snapshot.ts
```

---

## Regenerating This File

```bash
pnpm snapshot
```

Runs `scripts/snapshot.ts`, which queries `git ls-files` and rewrites both `docs/project-tree.md` and `docs/key-files-snapshot.md`. Commit the changes alongside the code change that triggered them.
