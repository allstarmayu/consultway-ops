# 08 — RBAC Matrix

Complete authorization matrix. Every resource × role × operation must have a
documented answer. When in doubt: **deny**.

**Enforcement layers:**
1. **Middleware** (`src/middleware.ts`) — coarse route-level gates (e.g. `/admin/*` → admin only)
2. **Payload access control** — per-collection, per-operation, filter-based
3. **UI** — conditional rendering of actions (belt-and-braces, never the only check)

---

## Roles

| Role | Description |
|---|---|
| `admin` | Consultway leadership / platform owner. Full control. |
| `staff` | Consultway operations team. Manages day-to-day. No finance. |
| `company-user` | Registered company personnel. Scoped to their own company. |

---

## Legend

| Symbol | Meaning |
|---|---|
| ✅ | Allowed |
| ❌ | Denied |
| 🟡 | Conditional (details in notes) |

---

## Matrix

### Users

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List all users | ✅ | ✅ | ❌ | |
| List users in my company | ✅ | ✅ | ✅ | Company user: scoped |
| Read any user | ✅ | ✅ | ❌ | |
| Read self | ✅ | ✅ | ✅ | |
| Create user | ✅ | 🟡 | ❌ | Staff: only company-users within companies they manage; cannot create admins |
| Update any user | ✅ | ❌ | ❌ | |
| Update self | ✅ | ✅ | ✅ | Cannot change `role` or `company_id` on self |
| Delete user | ✅ | ❌ | ❌ | Soft-delete (status → `disabled`) |
| Reset any user's password | ✅ | ❌ | ❌ | |

### Companies

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| Register (self-service, public) | n/a | n/a | n/a | Public endpoint, not a role action |
| List all companies | ✅ | ✅ | ❌ | |
| Read any company | ✅ | ✅ | ❌ | |
| Read own company | ✅ | ✅ | ✅ | |
| Update any company | ✅ | ✅ | ❌ | Staff cannot change `status` except `pending → active`. Only admin can `suspend`/`reject`. |
| Update own company | ✅ | ✅ | 🟡 | Can update address, contacts. Cannot change CIN, status, or verification fields. |
| Verify company (`pending → active`) | ✅ | ✅ | ❌ | Precondition: all mandatory docs verified |
| Reject company | ✅ | ❌ | ❌ | |
| Suspend company | ✅ | ❌ | ❌ | |
| Delete company | ✅ | ❌ | ❌ | Cascades to docs (cautious; prefer suspend) |
| Export company CSV | ✅ | ✅ | ❌ | |

### Documents

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List all documents | ✅ | ✅ | ❌ | |
| List own company's documents | ✅ | ✅ | ✅ | |
| Read any document | ✅ | ✅ | ❌ | |
| Read own company's document | ✅ | ✅ | ✅ | |
| Upload document for any company | ✅ | ✅ | ❌ | |
| Upload document for own company | ✅ | ✅ | ✅ | |
| Update document metadata | ✅ | ✅ | 🟡 | Company user: only if status is `pending_review` or `rejected` |
| Verify document | ✅ | ✅ | ❌ | |
| Reject document (with reason) | ✅ | ✅ | ❌ | |
| Delete document | ✅ | ❌ | 🟡 | Company user: only if status is `pending_review` or `rejected` |

### Tenders

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List all tenders (all statuses) | ✅ | ✅ | ❌ | |
| List published tenders | ✅ | ✅ | ✅ | Company users only see `published` |
| Read any tender | ✅ | ✅ | 🟡 | Company users only see `published` |
| Create tender (as `draft`) | ✅ | ✅ | ❌ | |
| Update tender | ✅ | ✅ | ❌ | Cannot edit after `published` except `closes_at` |
| Publish tender | ✅ | ✅ | ❌ | |
| Close tender | ✅ | ✅ | ❌ | |
| Archive tender | ✅ | ❌ | ❌ | |
| Delete tender | ✅ | ❌ | ❌ | Only if `draft` and never published |

### Tender Applications

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List all applications | ✅ | ✅ | ❌ | |
| List own applications | ✅ | ✅ | ✅ | Company user: scoped to own company |
| Read any application | ✅ | ✅ | ❌ | |
| Read own application | ✅ | ✅ | ✅ | |
| Submit application | ❌ | ❌ | ✅ | Only company users. Must be eligible + tender must be `published` + not past `closes_at` |
| Withdraw own application | ❌ | ❌ | 🟡 | Only while status is `submitted` |
| Decide application (shortlist/reject/award) | ✅ | ✅ | ❌ | |
| Delete application | ✅ | ❌ | ❌ | |

### Projects (Phase 3)

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List all projects | ✅ | ✅ | ❌ | |
| List own company's projects | ✅ | ✅ | ✅ | |
| Read any project | ✅ | ✅ | ❌ | |
| Read own company's project | ✅ | ✅ | ✅ | |
| Create project | ✅ | ✅ | ❌ | |
| Update project | ✅ | ✅ | ❌ | |
| Delete project | ✅ | ❌ | ❌ | |
| Manage milestones | ✅ | ✅ | ❌ | Company users can view milestones read-only |
| Comment on project | ✅ | ✅ | ✅ | |

### Transactions (Phase 3 — Admin-only)

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List transactions | ✅ | ❌ | ❌ | Enforced at Payload access — staff and companies get 403 |
| Read transaction | ✅ | ❌ | ❌ | |
| Create transaction | ✅ | ❌ | ❌ | |
| Update transaction | ✅ | ❌ | ❌ | |
| Delete transaction | ✅ | ❌ | ❌ | |
| Export transactions CSV | ✅ | ❌ | ❌ | |

### Reports

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| Generate company report PDF (any company) | ✅ | ✅ | ❌ | |
| Generate own company report PDF | ✅ | ✅ | ✅ | |
| Generate monthly org report PDF | ✅ | ✅ | ❌ | Staff sees version without financial figures |

### Notifications

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| List own notifications | ✅ | ✅ | ✅ | |
| Mark own notification read | ✅ | ✅ | ✅ | |
| Create notification (programmatic only) | n/a | n/a | n/a | Never directly exposed |

### Audit Log

| Operation | Admin | Staff | Company User | Notes |
|---|---|---|---|---|
| View audit log | ✅ | 🟡 | ❌ | Staff can view but cannot see finance events |
| Export audit log | ✅ | ❌ | ❌ | |

---

## Implementing in Payload

Example: `Companies` collection access.

```ts
// src/collections/Companies.ts
import type { CollectionConfig } from 'payload';

export const Companies: CollectionConfig = {
  slug: 'companies',
  admin: {
    useAsTitle: 'legalName',
    defaultColumns: ['legalName', 'cin', 'status', 'registeredAt'],
  },
  access: {
    /** READ: admins/staff see all; company users see only their own. */
    read: ({ req: { user } }) => {
      if (!user) return false;
      if (user.role === 'admin' || user.role === 'staff') return true;
      // company-user: scope by their company relation
      if (user.company) {
        return { id: { equals: typeof user.company === 'string' ? user.company : user.company.id } };
      }
      return false;
    },
    /** CREATE: only admin/staff (public self-registration uses a different endpoint). */
    create: ({ req: { user } }) =>
      !!user && (user.role === 'admin' || user.role === 'staff'),
    /** UPDATE: scope + field-level guards. */
    update: ({ req: { user } }) => {
      if (!user) return false;
      if (user.role === 'admin' || user.role === 'staff') return true;
      if (user.company) {
        return { id: { equals: typeof user.company === 'string' ? user.company : user.company.id } };
      }
      return false;
    },
    /** DELETE: admin only. */
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
  fields: [
    { name: 'legalName', type: 'text', required: true },
    { name: 'cin', type: 'text', required: true, unique: true },
    // Status is admin/staff-writable only — guarded at field level too
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Active', value: 'active' },
        { label: 'Suspended', value: 'suspended' },
        { label: 'Rejected', value: 'rejected' },
      ],
      access: {
        // Company users can READ but not UPDATE the status field
        update: ({ req: { user } }) =>
          !!user && (user.role === 'admin' || user.role === 'staff'),
      },
    },
    // … other fields
  ],
};
```

---

## Implementing in Middleware

```ts
// src/middleware.ts
import { NextResponse, type NextRequest } from 'next/server';

// Routes that require auth
const PROTECTED_PREFIXES = ['/dashboard', '/companies', '/documents', '/tenders',
  '/applications', '/projects', '/transactions', '/reports', '/settings', '/admin'];

// Routes that require admin/staff
const STAFF_ONLY_PREFIXES = ['/companies', '/admin'];

// Routes that require admin only
const ADMIN_ONLY_PREFIXES = ['/transactions', '/admin/settings'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const token = req.cookies.get('payload-token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // We do coarse routing here; fine-grained checks happen server-side.
  // Decoding the JWT in middleware is cheap; we extract role for route gates.
  // NOTE: Edge middleware cannot import Node crypto APIs that payload uses.
  // We use a lightweight JWT peek (no signature verification here — server-side
  // handlers revalidate the token). Middleware just redirects based on role claim.

  // (Decode omitted for brevity — use `jose` which is Edge-compatible.)

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

---

## Testing RBAC

We add a Playwright suite specifically for RBAC:

```ts
// tests/e2e/rbac.spec.ts
import { test, expect } from '@playwright/test';

test.describe('RBAC — company user cannot see another company', () => {
  test('404 on cross-company doc access', async ({ page }) => {
    await loginAs(page, 'companyA@example.com');
    const response = await page.request.get('/api/companies/<companyB-id>');
    expect(response.status()).toBe(404);
  });

  test('no transactions link for company user', async ({ page }) => {
    await loginAs(page, 'companyA@example.com');
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: /transactions/i })).toHaveCount(0);
  });
});
```

Run before every deploy. If any RBAC test fails → block the merge.
