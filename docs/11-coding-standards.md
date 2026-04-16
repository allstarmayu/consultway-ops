# Coding Standards

House rules for the Consultway codebase. Keep these visible — most code review comments will trace back here.

## 1. Language & Types

### TypeScript is strict, always

`tsconfig.json` has `"strict": true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Don't loosen these.

**Do:**
```ts
function findUser(id: string): User | null {
  return users.find(u => u.id === id) ?? null;
}
```

**Don't:**
```ts
function findUser(id: any): any {       // ❌ any
  return users.find(u => u.id === id);  // ❌ implicit undefined
}
```

### `any` is banned. `unknown` + narrowing is the alternative.

If you're pulling in an external payload, type it as `unknown` and validate with Zod at the boundary.

### No non-null assertions (`!`) except in tests

If you *know* something isn't null, prove it with a guard. The one exception: test files may use `!` for brevity on setup data.

### Prefer `type` over `interface`

Unless you need declaration merging (rare — mostly for module augmentation). `type` composes more cleanly with unions and utility types.

### Enums → string literal unions

```ts
// ✅
type UserRole = 'admin' | 'staff' | 'company_user';

// ❌ — TS enums transpile to runtime objects and aren't tree-shakable
enum UserRole { Admin, Staff, CompanyUser }
```

## 2. File & Folder Layout

```
app/
  (auth)/              # route group — unauthenticated pages
    login/page.tsx
    register/page.tsx
  (dashboard)/         # route group — authenticated
    layout.tsx
    companies/
      page.tsx
      [id]/page.tsx
  api/
    health/route.ts
    r2/presign/route.ts
components/
  ui/                  # shadcn primitives — don't modify, regenerate
  forms/
  layout/
lib/
  auth/
  db/
    schema.ts
    client.ts
  email/
  r2/
  validators/          # Zod schemas live here, not next to routes
actions/               # Server Actions grouped by domain
  companies.ts
  tenders.ts
payload/               # Payload config + collections
  collections/
  access/
  hooks/
tests/
  unit/
  e2e/
```

**Rules:**
- One default export per file, named to match the file.
- Co-locate a component's styles/types/tests only if small. Otherwise split.
- Never import from `app/` into `lib/` or `components/`. Dependencies flow one way: `lib` → `components` → `app`.

## 3. Naming

| Kind | Convention | Example |
|------|-----------|---------|
| Files (components) | PascalCase | `TenderCard.tsx` |
| Files (everything else) | kebab-case | `auth-helpers.ts` |
| React components | PascalCase | `TenderCard` |
| Hooks | `use` + camelCase | `useCurrentUser` |
| Functions | camelCase, verb-first | `createTender`, `getUserById` |
| Boolean variables | `is` / `has` / `can` prefix | `isActive`, `hasAccess` |
| Constants | UPPER_SNAKE_CASE | `MAX_FILE_SIZE` |
| Types | PascalCase | `TenderStatus` |
| DB tables & columns | snake_case | `audit_log`, `created_at` |
| Route params | camelCase in TS, kebab in URL | `/companies/[companyId]` |

## 4. React & Next.js

### Server Components by default

Only add `'use client'` when you actually need interactivity, browser APIs, or React state/effects. If a component passes through props without reading them interactively, it stays on the server.

### Server Actions for mutations

Mutations go through Server Actions (`actions/*.ts`). API Route Handlers (`app/api/*`) are reserved for:
- Webhooks (Resend, Cloudflare)
- Presigned URL generation (R2)
- Health checks and anything external systems call

### Every Server Action validates input with Zod

```ts
'use server';

import { z } from 'zod';
import { requireRole } from '@/lib/auth';

const schema = z.object({
  title: z.string().min(3).max(200),
  deadline: z.string().datetime(),
  sector: z.enum(['solar', 'infrastructure', 'it']),
});

export async function createTender(input: unknown) {
  await requireRole('admin', 'staff');
  const data = schema.parse(input);
  // ... insert
}
```

### Data fetching

- **Server Components:** fetch directly via Drizzle. No `fetch('/api/…')` to your own backend.
- **Client Components:** use Server Actions or, for read-only lists with interactivity, pass data as props from a parent Server Component.
- Wrap async data boundaries in `<Suspense>` with a skeleton fallback.

### Forms

- `react-hook-form` + `@hookform/resolvers/zod`.
- Error messages render inline next to the field — never as a toast for form validation.
- Submit button shows a spinner and is disabled while pending.

## 5. Database

- Schema lives in `lib/db/schema.ts`. One source of truth.
- Never write raw SQL in route handlers or components. Use Drizzle query builders.
- Every mutation that touches more than one table goes through `db.transaction(async (tx) => { … })`.
- Money is `INTEGER` (paise). Never `REAL`. See [05-database-schema.md](./05-database-schema.md).
- Every table has `created_at`, `updated_at`, and (where applicable) `deleted_at` as ISO TEXT.

## 6. Error Handling

### Server Actions return typed results, not throw

```ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export async function createTender(input: unknown): Promise<Result<Tender>> {
  try {
    // ...
    return { ok: true, data: tender };
  } catch (e) {
    logger.error({ err: e }, 'createTender failed');
    return { ok: false, error: { code: 'INTERNAL', message: 'Could not create tender' } };
  }
}
```

The caller pattern-matches on `result.ok`. No try/catch in the UI layer for domain errors.

### Never leak internal error messages to users

Log the real error server-side. Return a generic, user-safe message.

### Route Handlers

Return `Response.json({ error }, { status })`. Use status codes from [06-api-reference.md](./06-api-reference.md).

## 7. Imports

Use the `@/` alias for everything in the repo root:

```ts
// ✅
import { db } from '@/lib/db/client';
import { TenderCard } from '@/components/tenders/TenderCard';

// ❌
import { db } from '../../../lib/db/client';
```

Import order (ESLint enforces):
1. Node built-ins (`node:fs`)
2. External packages (`react`, `next/*`, `zod`)
3. Internal aliases (`@/lib/*`, `@/components/*`)
4. Relative (`./`, `../`) — should be rare
5. Types (`import type { … }`) — always separate

## 8. Styling

- Tailwind utility classes. No CSS files except `globals.css` and Tailwind config.
- Use design tokens from [07-design-system.md](./07-design-system.md). Don't hardcode hex colors.
- For conditional classes use `cn()` (from `lib/utils.ts`, wraps `clsx` + `tailwind-merge`).
- Do not use arbitrary values (`w-[437px]`) without a written justification in the PR.

```tsx
import { cn } from '@/lib/utils';

<button
  className={cn(
    'rounded-md px-4 py-2 font-medium',
    variant === 'primary' && 'bg-navy text-white hover:bg-navy/90',
    variant === 'danger' && 'bg-accent text-white',
    disabled && 'cursor-not-allowed opacity-50',
  )}
/>
```

## 9. Comments

Write comments that explain **why**, not **what**.

```ts
// ✅ Why — explains a non-obvious constraint
// D1 has no JSONB; we store as TEXT and parse at the edge to keep indexes usable.
const metadata = JSON.parse(row.metadata_json);

// ❌ What — restates the code
// Parse the JSON
const metadata = JSON.parse(row.metadata_json);
```

- JSDoc on all exported functions in `lib/`.
- `// TODO(username): description` with a name so we know who to ask.
- `// FIXME` for known bugs that need to be filed as issues within the same PR.

## 10. Git & Commits

### Branch naming

```
feat/tender-create-form
fix/login-redirect-loop
chore/bump-next-16.2
docs/update-rbac-matrix
```

### Conventional Commits (enforced by Commitlint)

```
<type>(<scope>): <short summary>

<optional body>

<optional footer — e.g., Closes #123>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`.

Examples:
```
feat(tenders): add eligibility filtering to list view
fix(auth): handle expired session cookies without redirect loop
chore(deps): bump next from 16.2.2 to 16.2.3
```

### One logical change per commit

If you're tempted to write "feat: add X and also fix Y", split it.

### PR requirements

- Linked issue or written context in the description.
- `pnpm verify` passes locally.
- Screenshots for any UI change.
- Reviewer checklist ticked (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- No merge commits on feature branches — rebase before merge.

## 11. Logging

- Use Pino (`lib/logger.ts`). Never `console.log` in committed code.
- Structured logs only:
  ```ts
  logger.info({ userId, tenderId }, 'Tender created');
  logger.error({ err }, 'createTender failed');
  ```
- Log levels: `trace` (local only), `debug`, `info` (happy path), `warn` (recoverable), `error` (needs attention), `fatal` (process death).
- Never log PII, passwords, tokens, or full request bodies.

## 12. Accessibility

- Every interactive element is keyboard-reachable.
- Form fields have labels (visible or `aria-label` — prefer visible).
- Color is never the only signal (use icons + text for status).
- Run Lighthouse a11y check before merging UI changes. Target: 95+.

## 13. Performance

- Measure before optimizing. Use Next.js build output and the Cloudflare analytics dashboard.
- Images: `<Image>` from `next/image`, never `<img>`.
- Heavy client components: `dynamic(() => import(…), { ssr: false })`.
- Dataset pages (tenders, transactions): paginate server-side. Default page size 25, max 100.

## 14. Security

- Never interpolate user input into SQL. Drizzle's query builder protects you — just don't call `sql.raw()`.
- Validate *every* input at the route/action boundary with Zod.
- CSRF: Next.js Server Actions are protected by default. Don't disable.
- Role checks happen **first** in every mutating Server Action (`requireRole(...)` as line 1 after `'use server'`).
- Rate limits on public routes — see [06-api-reference.md](./06-api-reference.md).

---

**Non-negotiables summary:**
1. `strict: true` stays on.
2. No `any`.
3. Zod-validate all inputs.
4. Role-check all mutations.
5. Money as integer paise.
6. Structured logs, no `console.log`.
7. Conventional Commits.
8. `pnpm verify` green before PR.
