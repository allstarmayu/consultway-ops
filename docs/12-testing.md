# Testing Strategy

Testing is scoped to maximize confidence per unit of effort inside a 3-week timeline. We don't chase 100% coverage — we target the paths where bugs would hurt most.

## 1. Testing Pyramid (what we actually do)

```
         ┌─────────────┐
         │  E2E (10%)  │   Playwright — critical user journeys only
         ├─────────────┤
         │Integration  │   Route handlers + Server Actions w/ in-memory D1
         │   (30%)     │
         ├─────────────┤
         │Unit (60%)   │   Vitest — pure logic, validators, utilities
         └─────────────┘
```

## 2. Tools

| Layer | Tool | Notes |
|-------|------|-------|
| Unit | Vitest | Fast, ESM-native, same config as Next.js |
| Component | Vitest + Testing Library | For client components with state |
| Integration | Vitest + `@cloudflare/vitest-pool-workers` | Runs in a Workers-like environment |
| E2E | Playwright | Chromium only in CI; local devs may run webkit/firefox |
| API mocking | MSW (Mock Service Worker) | For external APIs (Resend) |
| DB fixtures | Custom seed helpers | Transactional: each test rolls back |

## 3. What We Test

### Always

- **Zod validators.** Every schema has at least one happy-path and one failure test.
- **Server Actions.** Success, authorization failure, validation failure.
- **Auth helpers.** `requireRole`, session parsing, expired token handling.
- **RBAC matrix.** See [08-rbac-matrix.md](./08-rbac-matrix.md) — one test per role × resource combo.
- **Critical utilities.** Money formatting, date helpers, slug generation.
- **E2E: the four journeys** (see §6).

### Sometimes

- Component rendering when props affect branching logic.
- Edge cases flagged during code review.

### Don't bother

- Trivial components that just render props.
- Third-party library behavior.
- Styling (visual regression is manual / screenshots in PRs).

## 4. File Layout

```
tests/
  unit/
    validators/
      tender.test.ts
      company.test.ts
    lib/
      auth.test.ts
      money.test.ts
  integration/
    actions/
      tenders.test.ts
      applications.test.ts
    api/
      r2-presign.test.ts
  e2e/
    auth.spec.ts
    company-onboarding.spec.ts
    tender-apply.spec.ts
    admin-approval.spec.ts
  fixtures/
    users.ts
    companies.ts
    tenders.ts
  setup.ts
```

Tests co-located with source are allowed (`Button.tsx` + `Button.test.tsx`) but discouraged for non-component tests — keeps the tree cleaner.

## 5. Unit Test Patterns

### Validator test

```ts
import { describe, it, expect } from 'vitest';
import { tenderCreateSchema } from '@/lib/validators/tender';

describe('tenderCreateSchema', () => {
  const valid = {
    title: 'Solar plant Rajasthan',
    deadline: '2026-06-01T00:00:00Z',
    sector: 'solar',
    valueInPaise: 5000000,
  };

  it('accepts valid input', () => {
    expect(() => tenderCreateSchema.parse(valid)).not.toThrow();
  });

  it('rejects title shorter than 3 chars', () => {
    const result = tenderCreateSchema.safeParse({ ...valid, title: 'ab' });
    expect(result.success).toBe(false);
  });

  it('rejects non-ISO deadline', () => {
    const result = tenderCreateSchema.safeParse({ ...valid, deadline: '2026-06-01' });
    expect(result.success).toBe(false);
  });

  it('rejects negative value', () => {
    const result = tenderCreateSchema.safeParse({ ...valid, valueInPaise: -1 });
    expect(result.success).toBe(false);
  });
});
```

### Pure function test

```ts
import { describe, it, expect } from 'vitest';
import { formatInr } from '@/lib/money';

describe('formatInr', () => {
  it.each([
    [0, '₹0.00'],
    [100, '₹1.00'],
    [123456789, '₹12,34,567.89'],
    [50, '₹0.50'],
  ])('formats %d paise as %s', (paise, expected) => {
    expect(formatInr(paise)).toBe(expected);
  });
});
```

## 6. Integration Tests (Server Actions)

Use an in-memory D1 instance spun up per test file. Each test runs in a transaction that's rolled back on teardown.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTender } from '@/actions/tenders';
import { setupTestDb, makeUser } from '@/tests/fixtures';

describe('createTender', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('creates a tender when called by admin', async () => {
    const admin = await makeUser({ role: 'admin' });
    const result = await createTender(
      { title: 'Test', deadline: '2026-06-01T00:00:00Z', sector: 'solar', valueInPaise: 100000 },
      { actingUser: admin },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.title).toBe('Test');
  });

  it('rejects when called by company_user', async () => {
    const user = await makeUser({ role: 'company_user' });
    const result = await createTender(
      { title: 'Test', deadline: '2026-06-01T00:00:00Z', sector: 'solar', valueInPaise: 100000 },
      { actingUser: user },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('rejects invalid input', async () => {
    const admin = await makeUser({ role: 'admin' });
    const result = await createTender({ title: 'x' }, { actingUser: admin });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });
});
```

## 7. E2E Tests (Playwright)

Only four flows, but they cover the commercial critical path. Each runs against a dedicated Cloudflare preview environment seeded from scratch.

### Flow 1 — Auth

```ts
// tests/e2e/auth.spec.ts
import { test, expect } from '@playwright/test';

test('admin can log in and reach dashboard', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name=email]', 'admin@consultway.local');
  await page.fill('[name=password]', 'ChangeMe123!');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/welcome/i)).toBeVisible();
});

test('wrong password shows error and stays on login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name=email]', 'admin@consultway.local');
  await page.fill('[name=password]', 'wrong');
  await page.click('button[type=submit]');
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
```

### Flow 2 — Company onboarding

New company self-registers → verifies email → uploads registration doc → waits for admin approval.

### Flow 3 — Tender apply

Approved company browses tenders → opens eligible tender → submits application with attachment → sees "submitted" state.

### Flow 4 — Admin approval

Admin sees pending company → reviews document → approves → company receives email → company user can now see tenders.

Each flow should complete in under 30 seconds. Anything slower means the test is doing too much — split it.

### Playwright config essentials

```ts
// playwright.config.ts
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

## 8. Fixtures & Seeds

Keep fixtures small, composable, and colocated in `tests/fixtures/`.

```ts
// tests/fixtures/users.ts
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { hash } from '@/lib/auth/password';

export async function makeUser(overrides: Partial<NewUser> = {}) {
  const user = {
    id: crypto.randomUUID(),
    email: `test+${Date.now()}@example.com`,
    passwordHash: await hash('Password123!'),
    role: 'company_user' as const,
    emailVerified: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  await db.insert(users).values(user);
  return user;
}
```

## 9. Running Tests

```bash
pnpm test                  # unit + integration, watch off
pnpm test:watch            # watch mode for active development
pnpm test:coverage         # generates coverage/ report
pnpm test:e2e              # Playwright — requires dev server or uses webServer config
pnpm test:e2e:ui           # Playwright UI mode — best for debugging
pnpm test:e2e:headed       # run with visible browser
```

## 10. Coverage Targets

We don't gate on coverage percentages, but we track them as a signal.

| Layer | Target |
|-------|--------|
| `lib/validators` | 95%+ (these are pure, no excuse) |
| `lib/` utilities | 85%+ |
| `actions/` | 80%+ (authorization branches covered) |
| `app/` components | Not tracked |

Coverage reports live in `coverage/` and are uploaded as CI artifacts.

## 11. CI

Tests run on every PR via `.github/workflows/ci.yml`:

```yaml
- name: Unit + integration
  run: pnpm test --run --coverage

- name: Build
  run: pnpm build

- name: E2E
  run: pnpm test:e2e
  env:
    PLAYWRIGHT_BASE_URL: ${{ steps.deploy-preview.outputs.url }}
```

A PR cannot merge until all three pass.

## 12. When a test fails in CI but passes locally

1. Check the Playwright trace (`test-results/` artifact).
2. Look for timing issues — add `await expect(...).toBeVisible()` instead of `page.waitForTimeout`.
3. Check if the test depends on seed order — fixtures should be deterministic.
4. If flaky, mark with `test.fixme` and file an issue immediately. Never retry-until-green.

---

**Principle:** A failing test is a friend. A flaky test is an enemy. Delete flaky tests if you can't fix them within the PR.
