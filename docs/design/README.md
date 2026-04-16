# Design Reference

Visual source-of-truth for the Consultway Ops portal. These are **reference material**, not live assets — the running app lives in `app/` and `components/`.

## Folder contents

### `figma-screenshots/`
Exported frames from the Figma wireframe. Each file maps to one screen in the portal:

| File | Screen | Status |
|---|---|---|
| `01-dashboard.png` | Dashboard — stat cards, tender status, payment status, monthly trend | Phase 3 |
| `02-companies-list.png` | Company roster with filters and pagination | Phase 1 |
| `03-tenders-list.png` | Tender board with Review / Bid / Won / Lost / No-Go | Phase 2 |
| `04-projects-list.png` | Projects with sub-projects, status, completion progress | Phase 3 |
| `05-transactions.png` | Invoices, receipts, payments, summary cards | Phase 3 |
| `06-reports.png` | Reports placeholder (scope TBD with client) | Phase 3 |
| `07-settings.png` | Profile + organization settings with tabs | Phase 1 |

### `logo/`
Brand assets. Drop the Consultway logo here as `consultway-logo.png` (or `.svg` — strongly preferred for scalability). When a screen in the live app needs the logo, we copy the right size into `public/`.

## How to use these

- **When building a page:** open the matching screenshot alongside your editor. Match the spirit of the design — layout, hierarchy, what info is on screen — not necessarily every pixel.
- **When designs drift:** the live UI is the source of truth, not the Figma. If you intentionally change something, note it in the PR description so the team knows the Figma is stale.
- **When the client asks "what will X look like":** send them the relevant screenshot from this folder.

## Brand tokens

See [../07-design-system.md](../07-design-system.md) for the full color palette, typography, and component guidelines. The live implementation lives in `app/globals.css` as CSS variables under `:root`.

**Quick reference:**

| Token | Hex | OKLCH | Usage |
|---|---|---|---|
| Navy (primary) | `#0D1B2A` | `oklch(0.211 0.034 253)` | Sidebar, primary buttons, body text on light bg |
| Deep blue | `#1A3A5C` | `oklch(0.297 0.045 253)` | Sidebar hover, card surfaces on dark |
| Accent red | `#E04040` | `oklch(0.591 0.207 27.5)` | CTAs, active nav indicator, focus rings |
| Off-white | `#F5F5F5` | `oklch(0.968 0 0)` | Alt-row backgrounds, muted surfaces |
| Muted grey | `#888888` | `oklch(0.556 0 0)` | Secondary text, sub-labels |

## Notes on the Figma

- Headings in the wireframe use **"TenderPro"** as a placeholder product name. In the live portal the product is called **"Consultway Ops"** — we're not rebranding the wireframe, just the shipped product.
- The wireframe shows a yellow "To Be Discussed" banner on Dashboard and Reports. Those are open scope items flagged by the design team, not features we need to implement as-shown.
