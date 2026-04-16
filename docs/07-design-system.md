# 07 — Design System

This portal shares brand identity with Consultway Infotech's public site
(see `Consultway_Website_Requirements.pdf` §5 "Design System and Visual
Direction") but adapts the rules for a **logged-in dashboard** — denser,
more utility, less marketing polish.

---

## Reference designs

The original Figma mockups for each screen are in `docs/design/figma-screenshots/`:

- `01-dashboard.png` — main dashboard with stat cards, tender status, payment status, monthly trend
- `02-companies-list.png` — companies roster with filters
- `03-tenders-list.png` — tender board with status columns
- `04-projects-list.png` — project tracking with sub-projects
- `05-transactions.png` — transaction management with summary cards
- `06-reports.png` — reports placeholder ("To Be Discussed")
- `07-settings.png` — profile and organization settings

The portal logo is in `docs/design/logo/consultway-logo.png`. Brand color reference is `docs/design/logo/brand-colors.png`.

These are **reference material only** — the live UI should match the spirit of the designs but may evolve based on implementation constraints and user feedback.

## Brand Tokens

### Colors

From the Consultway brand (logo + marketing site):

| Token | Hex | Tailwind | Usage |
|---|---|---|---|
| `--brand-navy` | `#0D1B2A` | `brand-navy` | Primary dark — headers on dark mode, strong text |
| `--brand-navy-light` | `#1A3A5C` | `brand-navy-light` | Secondary dark, hover states |
| `--brand-accent` | `#E04040` | `brand-accent` | CTA buttons, active indicators, alerts |
| `--brand-green` | `#2FA676` | `brand-green` | Solar / success states (from the logo's green arc) |
| `--brand-gold` | `#F5A623` | `brand-gold` | Warnings, document-expiring states (from logo accent) |

### Neutrals

We use shadcn/ui's neutral slate palette:

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--background` | `#FFFFFF` | `#0D1B2A` | Page background |
| `--foreground` | `#0F172A` | `#F8FAFC` | Body text |
| `--muted` | `#F1F5F9` | `#1E293B` | Card backgrounds, section dividers |
| `--muted-foreground` | `#64748B` | `#94A3B8` | Sub-labels, hints |
| `--border` | `#E2E8F0` | `#1E293B` | Dividers, input borders |

### Semantic Status Colors

These map to company/document/application statuses:

| Status | Color | Usage |
|---|---|---|
| `pending` / `pending_review` | `amber-500` `bg-amber-100` | "Awaiting" states |
| `active` / `verified` / `awarded` | `emerald-600` `bg-emerald-100` | Positive terminal |
| `rejected` / `expired` | `red-600` `bg-red-100` | Negative terminal |
| `suspended` / `on-hold` | `slate-600` `bg-slate-100` | Neutral-bad |
| `draft` | `slate-500` `bg-slate-100` | In-progress |
| `published` / `submitted` | `blue-600` `bg-blue-100` | In-flight |
| `closed` / `completed` | `indigo-600` `bg-indigo-100` | Archived positive |

---

## Tailwind Config

```ts
// tailwind.config.ts
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        brand: {
          navy:       '#0D1B2A',
          'navy-light': '#1A3A5C',
          accent:     '#E04040',
          green:      '#2FA676',
          gold:       '#F5A623',
        },
        border:            'hsl(var(--border))',
        input:             'hsl(var(--input))',
        ring:              'hsl(var(--ring))',
        background:        'hsl(var(--background))',
        foreground:        'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
```

---

## Typography

**Font:** Inter (via `next/font/google`).

```ts
// src/app/layout.tsx
import { Inter } from 'next/font/google';
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});
```

| Use | Size | Weight | Class |
|---|---|---|---|
| Page title (H1) | 30px / 1.2 | 700 | `text-3xl font-bold tracking-tight` |
| Section (H2) | 24px / 1.3 | 700 | `text-2xl font-semibold` |
| Card title (H3) | 18px / 1.4 | 600 | `text-lg font-semibold` |
| Body | 14px / 1.5 | 400 | `text-sm` |
| Small / meta | 12px / 1.5 | 400 | `text-xs text-muted-foreground` |
| Button | 14px | 500 | `text-sm font-medium` |

Why 14px body (not 16)? Dashboards pack more information per screen than
marketing pages. 14px is Linear/Notion/Vercel-dashboard convention.

---

## Spacing

Tailwind's default scale (`0.25rem` = 4px steps). Standard spacings:

| Token | Pixels | Use |
|---|---|---|
| `p-2` | 8 | Tight cell padding |
| `p-3` | 12 | Icon buttons |
| `p-4` | 16 | Default card padding |
| `p-6` | 24 | Page-level card padding |
| `p-8` | 32 | Hero/empty state |
| `gap-2` | 8 | Inline icon+label |
| `gap-4` | 16 | Form fields |
| `gap-6` | 24 | Sections |

**Page gutter:** `px-6` on desktop, `px-4` on mobile. Use the `Container` component.

---

## Core Components (shadcn/ui)

Install order (Day 4):

```bash
pnpm dlx shadcn@latest add button input label textarea select checkbox \
  radio-group dialog sheet dropdown-menu popover tooltip toast sonner \
  avatar badge card separator skeleton tabs toggle form table \
  command alert alert-dialog progress scroll-area
```

### Button variants we use

```tsx
<Button variant="default">Primary action</Button>        // brand-accent bg
<Button variant="secondary">Secondary</Button>            // neutral
<Button variant="outline">Cancel</Button>
<Button variant="ghost">Icon button</Button>
<Button variant="destructive">Delete</Button>
<Button variant="link">Learn more</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large (CTA)</Button>
<Button size="icon"><TrashIcon /></Button>
```

### Status badges

```tsx
// src/components/ui/status-badge.tsx
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

type CompanyStatus = 'pending' | 'active' | 'suspended' | 'rejected';

const STATUS_STYLES: Record<CompanyStatus, string> = {
  pending:   'bg-amber-100 text-amber-900 hover:bg-amber-100',
  active:    'bg-emerald-100 text-emerald-900 hover:bg-emerald-100',
  suspended: 'bg-slate-200 text-slate-900 hover:bg-slate-200',
  rejected:  'bg-red-100 text-red-900 hover:bg-red-100',
};

const STATUS_LABELS: Record<CompanyStatus, string> = {
  pending:   'Pending review',
  active:    'Active',
  suspended: 'Suspended',
  rejected:  'Rejected',
};

interface Props { status: CompanyStatus; className?: string }

export function CompanyStatusBadge({ status, className }: Props) {
  return (
    <Badge className={cn(STATUS_STYLES[status], className)} variant="secondary">
      {STATUS_LABELS[status]}
    </Badge>
  );
}
```

---

## Layout Patterns

### Page shell

Every authenticated page uses the same shell:

```
┌──────────────────────────────────────────────────────┐
│  TopBar: logo · search · notifications · avatar     │ 56px
├────────┬─────────────────────────────────────────────┤
│        │                                             │
│        │  Page title                                 │
│        │  Optional subtitle                          │
│        │                                             │
│ Side   │  ┌───────────────────────────────────────┐  │
│ bar    │  │                                        │  │
│ 240px  │  │         Page content                   │  │
│        │  │                                        │  │
│        │  └───────────────────────────────────────┘  │
│        │                                             │
└────────┴─────────────────────────────────────────────┘
```

### `PageHeader` component

```tsx
// src/components/layouts/page-header.tsx
import { type ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 pb-6 border-b">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
```

### Empty states

Every list has one. Always include:
- A relevant icon (from `lucide-react`)
- A one-line primary message
- A sub-line explaining the next step
- A primary CTA

```tsx
<EmptyState
  icon={<FileTextIcon />}
  title="No documents yet"
  description="Upload your company's registration certificates to get started."
  action={<Button onClick={openUpload}>Upload document</Button>}
/>
```

### Loading states

- **List/table** → `<Skeleton>` rows matching the final layout (not spinners)
- **Detail page** → Skeleton of the final layout
- **Action in progress** → button's `disabled` + inline spinner, NOT a page-level overlay

### Error states

- **In-page error** → `<Alert variant="destructive">` with a retry action
- **Field error** → shadcn `FormMessage` under the input
- **Toast** for transient errors (action failed)
- **Error boundary** only for unexpected crashes

---

## Motion

- **Page transitions:** none. They slow down dashboards.
- **Modal enter:** Radix default (150ms fade + scale)
- **Toast:** slide-in from bottom-right
- **List items:** no enter animation; invalidate-and-replace is faster perceptually
- **Sidebar collapse:** 200ms ease on width
- **Respect `prefers-reduced-motion`** everywhere — Framer Motion handles this via `useReducedMotion()`

---

## Iconography

**Library:** `lucide-react` only. No other icon sets.

**Sizes:** `16px` inline with text, `20px` in buttons, `24px` in section headers.

```tsx
import { BuildingIcon } from 'lucide-react';
<BuildingIcon className="h-4 w-4" />
```

---

## Forms

Convention — always shadcn `<Form>` + React Hook Form + Zod. No free-form inputs.

```tsx
const form = useForm<RegisterCompanyInput>({
  resolver: zodResolver(companyRegistrationSchema),
  defaultValues: { /* ... */ },
});

<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
    <FormField
      control={form.control}
      name="legalName"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Legal name</FormLabel>
          <FormControl><Input {...field} /></FormControl>
          <FormDescription>As registered with MCA.</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
    <Button type="submit" disabled={form.formState.isSubmitting}>
      {form.formState.isSubmitting ? 'Saving…' : 'Save'}
    </Button>
  </form>
</Form>
```

---

## Accessibility Checklist

- [ ] Every interactive element has a visible focus ring (`focus-visible:ring-2`)
- [ ] Color is not the only signal (pair with icon/text)
- [ ] All images have `alt`
- [ ] Form fields have associated labels
- [ ] Modals trap focus (Radix does this by default)
- [ ] Tables have `<caption>` for screen readers
- [ ] Contrast ≥ 4.5:1 for body, 3:1 for large text
- [ ] Keyboard-only navigation works end-to-end

Run `pnpm test:a11y` (axe-core via Playwright) before every phase demo.

---

## Dark Mode

Automatic system preference via `next-themes`, with a toggle in the avatar menu.

Shadcn's CSS variables are already mode-aware; nothing else to do. Test every
page in both modes on Day 4.

---

## Figma Alignment

The provided Figma screenshot of the dashboard + logo + colors are the reference
truth. When the spec here and Figma disagree → Figma wins. Log the delta in
`docs/design-deltas.md` (create as needed) so decisions are traceable.
