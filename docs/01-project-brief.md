# 01 — Project Brief

## Client

**Consultway Infotech** — a project management consultancy based in India that
connects private-sector companies with government-backed infrastructure and
solar projects. They handle documentation, compliance, CSR alignment, and
end-to-end partnership management.

## Problem Statement

Consultway currently operates their entire back-office through Excel sheets,
WhatsApp threads, email chains, and phone calls. This creates:

- **Data scatter** — no single source of truth for company information
- **Document chaos** — no central repository, no expiry tracking, manual renewals
- **Lost tenders** — companies miss opportunities because updates go through WhatsApp
- **No audit trail** — who approved what, when, for which project
- **Scaling ceiling** — the team cannot grow beyond a handful of clients without a system

## Solution

An internal, role-aware web platform that **replaces** these manual workflows
with a single operational system.

> ⚠️ This is **not** the public marketing site at `consultway.info`. That site
> is a separate Astro-based project (documented in
> `Consultway_Website_Requirements.pdf`). This project is the **internal
> dashboard portal** — login-gated, for staff and registered companies only.

## Goals

### Primary

1. **Digitize company onboarding** — self-service portal for companies to
   register, upload documents, and maintain their profile.
2. **Centralize tender management** — Consultway publishes tenders; companies
   discover and apply through the platform.
3. **Automate compliance reminders** — document expiry notifications sent
   automatically instead of manually tracked in Excel.
4. **Provide an admin control panel** — Consultway staff see everything at a
   glance, verify documents, manage tender lifecycle.

### Secondary

- Reduce time-to-onboard for a new company from ~2 weeks to **under 48 hours**
- Zero missed document renewals (reminders fire 30/14/7/1 days before expiry)
- 100% of tender applications trackable in one place
- Role-based access — companies only see their own data; staff see everything
  assigned to them; admins see all

## Non-Goals (explicitly out of scope)

- **Public-facing marketing content** — lives on the separate Astro site
- **Mobile native apps** — responsive web is sufficient for v1
- **Real-time chat** — WhatsApp/email continue to handle conversations
- **Payment gateway integration** — transactions are recorded manually in Phase 3
- **Multi-language** — English only for v1 (i18n is a Phase 4+ consideration)
- **Third-party calendar sync** — not required for internal operations

## Success Criteria

At end of project, the following must be true:

| # | Criterion | How we verify |
|---|---|---|
| 1 | A new company can self-register and upload their 5 mandatory documents | Manual walkthrough |
| 2 | Consultway staff can verify documents and mark a company "Active" | Manual walkthrough |
| 3 | Admin can create a tender, set eligibility filters, publish it | Manual walkthrough |
| 4 | Eligible companies see the tender and can apply | Manual walkthrough |
| 5 | Document expiry reminder fires at T-30, T-14, T-7, T-1 days | Cron job + email inspection |
| 6 | Role-based access works — no company can see another company's data | Automated test + manual audit |
| 7 | The admin dashboard loads and reflects accurate counts in under 1 second | Lighthouse + manual timing |
| 8 | Site scores ≥ 90 on Lighthouse Performance on mobile | Lighthouse CI |
| 9 | Platform runs on Cloudflare free/low-tier (≤ ₹2,000/month) | Cloudflare billing dashboard |
| 10 | All code passes lint + typecheck + tests in CI | GitHub Actions green |

## Stakeholders

| Role | Person | Responsibility |
|---|---|---|
| Client (Decision Maker) | Consultway Infotech leadership | Sign-off on scope and UAT |
| Technical Lead | Code Uncode engineer | End-to-end implementation |
| End User — Admin | Consultway senior staff | Platform configuration, approvals |
| End User — Staff | Consultway operations team | Daily company/tender management |
| End User — Company | Registered partner companies | Self-service registration, applications |

## Timeline

**Total:** 2–3 weeks of focused development (~ 21 calendar days)
**Methodology:** Phased incremental delivery — each phase is shippable on its own
**Demo cadence:** End of each phase, ≈ 15-minute walkthrough with screenshots + working URL

See [`03-development-phases.md`](./03-development-phases.md) for the detailed breakdown.

## Budget Alignment

Maps to **Proposal A (Launchpad, ₹7,50,000)** for Phases 0–2 and
**Proposal B (Full Ops Suite, ₹14,50,000)** for all three phases combined.

The technical plan below delivers the Full Ops Suite scope.

## Key Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Payload CMS + D1 adapter is relatively new; edge cases possible | Medium | Medium | Use the official `@payloadcms/db-d1-sqlite` adapter; fall back to `@payloadcms/db-sqlite` on Node runtime if needed |
| Cloudflare Workers CPU/memory limits on large PDF generation | Medium | Low (Phase 3) | Generate PDFs client-side with `pdf-lib` or offload to a Worker queue |
| Document uploads exceed Workers 100 MB request limit | Low | Medium | Use R2 presigned URLs — upload goes direct to R2, bypasses Worker |
| Resend free tier (3,000 emails/month) exceeded | Low | Low | Monitor; upgrade to paid plan (~₹1,700/mo) when volume grows |
| D1 has no native enums or FTS | Certain | Low | Known; designed around with CHECK constraints + filter-based search |
