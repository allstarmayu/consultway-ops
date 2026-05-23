# Day 20 — PDF report generation + CSV perPage fix + reports company-picker

_Date: 2026-05-23_

## Scope

Three deliverable chunks on top of Day-19's `/dashboard/reports`
foundation. No new migration, no new tables — the new surfaces all sit
on the existing aggregate helpers plus one new dependency
(`@react-pdf/renderer`). Each chunk is its own commit on `dev`:

1. **PDF report generation.** Branded PDF of the same period payload the
   HTML report shows. Pure `lib/reports/pdf.tsx` renderer +
   admin/staff-only `/dashboard/reports/pdf` route + "Download PDF"
   action on the report header.
2. **CSV exporter `perPage` cap fix.** Latent Day-17/18/19 bug: all
   three CSV exporters pass `perPage=1000` against schemas that capped
   at 100. Sibling export-only Zod schemas widen the cap to 1000;
   `list*ForExport` action wrappers parse with them and delegate to a
   shared inner helper. List-page strict 100 cap stays intact.
3. **Reports company-picker.** Day 19's `?companyId=` URL parameter was
   wired through every helper but unreachable from the UI. A native
   `<select>` chip lands next to the period picker, URL-shaped, with
   "All companies" + one option per row in the company roster.

End-of-session verification: `pnpm exec tsc --noEmit` silent;
`pnpm test --run` 470/470 green every run (was 459; +11 net);
`pnpm cron:expiry-sweep` reports the expected
`remindersSkippedDeduped=1`; `pnpm cron:pending-cleanup` clean.

Also landed pre-Chunk-1: `docs/seed-plan.md` — Day-21 UAT fixture
buildout plan, bundled in the report commit so it lands alongside this
report.

## What shipped

### Chunk 1 — PDF report generation (commit `d9c790b`)

**New dep: `@react-pdf/renderer ^4.5.1`.** Single add, pure JS,
Workers-safe under `nodejs_compat` (already on per `wrangler.jsonc`).
Lockfile updated, no other dep churn.

**`lib/reports/pdf.tsx` — pure renderer.** Takes the resolved
`(start, end, role, companyName?, projects, tenders, transactions?)`
payload and returns a `Uint8Array<ArrayBuffer>` of PDF bytes via
`@react-pdf/renderer`'s `renderToBuffer`. Sections:

- Branded cover: "Consultway Infotech" wordmark, "Operations & Financial
  Summary" title, period bounds, optional company name (or "All
  companies" when omitted), generation timestamp.
- Projects-created — per-status table with all 5 statuses zero-filled +
  per-card "N total" header.
- Tenders-published — per-status table with all 4 statuses zero-filled.
- Transactions (admin-only) — per-type grid (count + paise-exact
  rupees-and-paise via `formatRupeesFromPaiseAscii` for ASCII safety on
  PDF copy-paste) + grand total footer row.
- Footer with auto page numbers via `<Text render={({ pageNumber,
  totalPages }) => ...}>`.

No DB calls, no session reads — the route handler owns auth + fetches
and hands the resolved payload in.

**`app/dashboard/reports/pdf/route.ts` — admin/staff-only GET handler.**

- Auth gate mirrors the HTML page: unauthenticated → 401; company-role
  → 403.
- Reads `?from=&to=&companyId=` with the same fallback shape as the
  HTML page (current calendar month UTC when from/to are missing or
  malformed).
- Runs the three period-bounded aggregates in parallel; staff get
  `Promise.resolve(null)` for transactions (admin-only section).
- Resolves `companyId → companyName` via one indexed lookup; an
  unknown id silently degrades to "All companies" rather than 404'ing
  the download (the aggregates would still run cleanly against an
  unknown id — a missing-name PDF is more useful than a 404).
- Renders via `renderReportPdf`; thrown errors → 500. Aggregate
  failures → 400 with the helper's error string.
- Dated filename: `consultway-report-YYYY-MM-DD.pdf` via
  `Content-Disposition`.

**`app/dashboard/reports/page.tsx` — "Download PDF" button.** Added to
the `PageHeader` actions slot (admin/staff visible). Forwards the
resolved `(start, end, companyId)` triple through to
`/dashboard/reports/pdf?…` so the downloaded report matches what's on
screen even when the URL didn't carry from/to and the page filled in
defaults.

**Tests in `lib/reports/__tests__/pdf.test.ts` (+5):**

- Returns a non-empty `Uint8Array` for an admin payload.
- Renders bytes starting with the `%PDF-` magic header (so we know it's
  a valid PDF envelope, not a text rendering of the payload).
- Renders cleanly for a staff payload (no transactions section).
- Renders cleanly for an empty-period payload (all zeros across every
  section).
- Renders cleanly when `companyName` is omitted (all-companies scope).

Tests assert byte properties (`byteLength > 0`, magic header) rather
than exact lengths so they stay stable across `@react-pdf/renderer`
minor upgrades that change compression behaviour.

Total at end of Chunk 1: **464 tests** (was 459; +5).

### Chunk 2 — CSV exporter `perPage` cap fix (commit `0790183`)

The latent bug Day 19 surfaced. All three exporters pass
`perPage: String(EXPORT_ROW_CAP)` where `EXPORT_ROW_CAP = 1000`, but
the matching `list*QuerySchema` schemas all cap `perPage` at **100**.
The first real 1000-row export request would Zod-fail
("Number must be less than or equal to 100") and 400. Pre-Day-19
pattern; no production export had hit it yet.

**Fix per Day-20 brief Option C — sibling export-only schemas:**

- `lib/transactions/schemas.ts` — new `listTransactionsForExportQuerySchema`
  = `listTransactionsQuerySchema.extend({ perPage: z.coerce.number().int().min(1).max(1000).default(20) })`.
- `lib/projects/schemas.ts` — same shape: `listProjectsForExportQuerySchema`.
- `lib/tenders/schemas.ts` — same shape: `listTendersForExportQuerySchema`.

Same filters, same sort, same defaults; only the `perPage` ceiling
moves from 100 to 1000.

**Action wrappers + shared inner helpers.** Because each action
re-parses with its own schema, the new schema alone wasn't enough — the
existing actions would still 400 on `perPage=1000`. Each module gains:

- A new `list*ForExport(rawQuery)` action that auth-gates + parses with
  the wider schema + delegates to a private `runList*ForCaller`
  helper.
- A refactored existing `list*` action that does the same shape but
  parses with the strict schema.
- A new `runList*ForCaller` private helper that takes the parsed
  `query` (and scope, for projects/tenders) and runs the actual
  listing query. Bodies are the existing per-action listing logic,
  lifted unchanged.

Net: ~50 lines of duplication removed (the inner body) + ~25 lines of
wrapper plumbing added per module = ~75 lines net for the three
modules together. Worth the lift — the duplication risked drift if a
future filter / sort change landed in only one variant.

**Route handlers swap to the new actions.** One-line change per file:

- `app/dashboard/transactions/export/route.ts` — `listTransactions` →
  `listTransactionsForExport`.
- `app/dashboard/projects/export/route.ts` — `listProjects` →
  `listProjectsForExport`.
- `app/dashboard/tenders/export/route.ts` — `listTenders` →
  `listTendersForExport`.

**Tests in the three existing list-test files (+6):**

- `lib/transactions/__tests__/list-actions.test.ts` —
  `listTransactionsForExport` accepts `perPage=1000` (returns all 6
  seeded rows on a 1000-row page); strict `listTransactions` still
  refuses `perPage=1000` with `result.field === "perPage"`.
- `lib/projects/__tests__/list-visibility.test.ts` — same pair for
  projects; export action returns all 6 seeded rows, strict action
  refuses.
- `lib/tenders/__tests__/list-visibility.test.ts` — same pair for
  tenders; export action returns all 8 seeded rows, strict action
  refuses.

Total at end of Chunk 2: **470 tests** (was 464; +6).

### Chunk 3 — Reports company-picker (commit `77286de`)

Day 19 wired `?companyId=` through every aggregate helper but left it
reachable only by direct-link. Chunk 3 surfaces a native picker chip
alongside the period picker so the URL parameter has a one-click UI
path.

**`app/dashboard/reports/_components/company-picker.tsx` — new Client
Component:**

- Native `<select>` with "All companies" (value `""`) + one option per
  row in the company roster.
- URL-shaped: every change calls `router.replace` with the updated
  searchParams. Selecting "All companies" deletes the param entirely
  rather than writing an empty value (keeps the URL clean for shared
  links).
- No client-side mirror of the selection state — every interaction
  round-trips through the router, same pattern as the period picker.

**`app/dashboard/reports/page.tsx` — picker mounted:**

- Fetches the lightweight `(id, name)` company list in parallel with
  `searchParams` resolution (mirrors the transactions / projects
  list pages' pattern).
- Picker sits to the left of the period picker on wide viewports
  (`lg:flex-row`); stacks above on narrow. Shares the same flex shell
  the period picker was using.
- Module docstring updated to reflect the new shell + the company
  picker's role.

**No new tests** — the URL-shape behaviour is exercised end-to-end by
the existing Chunk 1 period-helper tests' `companyId` narrowing
assertions; the picker itself is a thin URL-rewriter on top of that
contract. Native `<select>` semantics need no additional pinning.

Total at end of Chunk 3: **470 tests** (unchanged from Chunk 2).

## Key decisions

**`@react-pdf/renderer` over Puppeteer / headless Chromium.** The
Day-20 brief calls this out: pure JS, Workers-safe under
`nodejs_compat`. Puppeteer-style headless Chromium would force a
sidecar service outside the Worker (Cloudflare doesn't run Chrome in
the isolate), which adds latency, a deploy target, and a billing line
the project doesn't need. The output quality difference for table-only
reports is invisible.

**PDF renderer is split from the route handler.** `renderReportPdf`
takes a pre-fetched payload; the route handler owns auth + DB. Two
wins: the renderer is unit-testable in isolation (no DB fixture
needed; 5 smoke tests cover the rendering contract), and the route
handler stays a thin shell around the existing aggregate helpers — the
HTML and PDF reports share the data layer character-for-character.

**ASCII rupees in the PDF transactions section.**
`formatRupeesFromPaiseAscii` ("Rs.12,345.67") instead of
`formatRupeesFromPaise` ("₹ 12,345.67"). Reasons:

1. The ₹ glyph is a multi-byte character that depending on the PDF
   font and viewer can mojibake on copy-paste into Excel / Notepad /
   downstream systems.
2. The PDF's text layer is grep-friendly when ASCII-only — a future
   "find Rs.5,00,000 invoices" search on a downloaded PDF works
   without UTF-8 awareness.

The HTML reports keep the ₹ glyph — the browser handles it cleanly.

**Cover page is text-only — no logo image.** `public/` has no
`logo.svg` today (only the Next default placeholders). Rather than
hold up the PDF surface on a brand asset that hasn't been finalised,
the cover uses a typographic wordmark ("Consultway Infotech" in
uppercase letter-spaced display type, terracotta tint) that reads as
branded without needing an image embed. When the real logo lands,
swap to `<Image src={...} />` in the cover.

**`Uint8Array<ArrayBuffer>` explicit on the renderer's return type.**
TS 5+ defaults `Uint8Array` to `Uint8Array<ArrayBufferLike>`, but
`NextResponse`'s `BodyInit` typing wants the narrower
`Uint8Array<ArrayBuffer>`. Without the narrowing, the route handler
fails compilation. Solved by allocating a fresh `ArrayBuffer` of the
exact byte length and `.set()`-ing into a new `Uint8Array<ArrayBuffer>`
view — no `as` cast needed.

**Aggregate row count mismatch graceful in PDF, strict in HTML.** An
unknown `companyId` passed to the PDF route degrades to "All
companies" on the cover rather than 404'ing the download — the
aggregates run cleanly against any id, the worst case is an
empty-rows PDF. A missing-name PDF is more useful than a hard error
when the user is mid-flow.

**Sibling Zod schemas + action wrappers, not a single widened cap.** The
Day-19 brief suggested two alternatives: widen the cap on the existing
schema (option A) or add export-only siblings (option C). Picked C
because:

1. Preserves the list page's 100-cap protection — a non-export caller
   that hits `?perPage=1000` on the URL still 400s, which is the right
   guardrail at the table level.
2. The duplication is tiny (one schema line per module) and the
   intent is explicit in the export route's import.
3. Schemas are leaf modules; adding a sibling has no blast radius.

**Shared inner helper, not duplicated action bodies.** Each module's
listing logic was 30-50 lines; duplicating it across the strict +
export wrappers would have invited drift. The `runList*ForCaller`
helper takes the already-parsed query (and resolved scope, for
projects/tenders) and runs the SQL — both wrappers call it identically
after their auth + parse.

**Inner-helper scope param is the resolved scope type from
`resolveReadScope`.** Projects' and tenders' inner helpers need the
caller's scope (admin / staff / company-with-its-companyId) to apply
the visibility rules. Rather than re-derive scope inside the helper,
the wrappers resolve it once at the top and pass it through. The
helper's `scope: Extract<Awaited<...>, { ok: true }>` typing pins the
"we've already auth-passed" precondition at the type level.

**Picker is URL-shaped with `""` ↔ "All companies".** Selecting "All
companies" deletes the `companyId` param entirely rather than writing
an empty value. Keeps shared links clean (`/dashboard/reports?from=...`
beats `/dashboard/reports?from=...&companyId=`); the URL is the source
of truth, and absent + empty are semantically the same to the page's
`resolvePeriod` parser.

**Picker uses a native `<select>`, not a typeahead combobox.** At
Phase-1 scale (<30 companies in the current roster + planned UAT
fixture set) the native control is plenty — typing the first letter
jumps to the right option, no autocomplete needed. The
transactions / projects filter bars already use the same pattern for
their company filter; matching them keeps the dashboard's interaction
language uniform. When the roster grows past a couple hundred, swap to
the same combobox component used elsewhere.

**Picker layout — `lg:flex-row` on the picker shell.** Reused the
period-picker's existing flex container rather than rebuilding the
layout. At narrow viewports both pickers stack; at `lg:` the company
picker sits to the left of the period picker. No new design tokens, no
new spacing primitives.

## Gotchas surfaced

**`@react-pdf/renderer` `renderToBuffer` returns `Buffer`, not
`Uint8Array`.** The API is `Promise<Buffer>` (`@platform node`). Even
though `Buffer extends Uint8Array`, the typed return is
`Uint8Array<ArrayBufferLike>`, which the current TS
`lib.dom.d.ts BodyInit` typing refuses for `NextResponse`. The renderer
copies into a fresh `ArrayBuffer` and explicitly narrows the return to
`Uint8Array<ArrayBuffer>` so the route handler doesn't need a cast.
Easy to miss when the runtime worked fine in earlier Node typings.

**JSX in `lib/reports/pdf.ts` requires the `.tsx` extension.** Initial
draft used `.ts` + `React.createElement`, then switched to JSX inside
component bodies — TS requires `.tsx` for the file to parse. Renamed
the file. Worth flagging: any future "pure data" module that wants to
return JSX needs the same rename, not just a `React.createElement`
escape hatch.

**`tsx` (the runner, not the extension) can't import the renamed
`.tsx` module via the `@/` alias in a standalone script.** Tried a
quick out-of-test smoke render — `tsx <path-to-script.mts>` with
`import { renderReportPdf } from "@/lib/reports/pdf"` failed with
"does not provide an export named 'renderReportPdf'" under Node 24
ESM. Vitest resolves it fine (uses its own moduleResolver). Worked
around by relying on the unit tests for the rendering contract —
which is enough; they cover the same byte-level assertions a manual
smoke would.

**Action body factoring touched the `count`-based pagination shape.**
The listing inner helpers preserve `result.total === totalRow.value`
behaviour from the original actions. A subtle refactor mistake would
have moved the `count(*)` query inside the helper but accidentally
let one of the wrappers compute it differently — the +6 regression
tests pin the export-wrapper count against the seeded fixture size.

**`getProjectsByStatusForPeriod` boundary on a `createdAt` row depends
on the seed clock.** Not new for Day 20 (Day-19 carry-forward), but
worth re-flagging: the Day-19 aggregates-period fixture seeds rows
with explicit `createdAt` timestamps so the boundary assertions are
reproducible. The Day-20 export tests work with the existing
`list-visibility` fixtures' `createdAt` defaults — they don't pin
boundary inclusivity, but they don't need to (perPage cap is a
schema-level concern, not a date-bounds concern).

**Picker layout on narrow viewports.** The `lg:flex-row` shell stacks
both pickers vertically below `lg:`. Without an explicit `gap-3`, the
period picker's own internal padding would have been the only
separator — the parent shell adds `gap-3` so the stack is visually
balanced regardless of the picker's internal margins.

## Surfaces touched

```
# Chunk 1 — PDF report generation (commit d9c790b)
app/dashboard/reports/page.tsx                                       (modified — Download PDF button + helper)
app/dashboard/reports/pdf/route.ts                                   (new — admin/staff GET handler)
lib/reports/__tests__/pdf.test.ts                                    (new — 5 smoke tests)
lib/reports/pdf.tsx                                                  (new — pure renderer)
package.json                                                         (modified — +@react-pdf/renderer)
pnpm-lock.yaml                                                       (modified — lockfile churn)

# Chunk 2 — CSV exporter perPage cap fix (commit 0790183)
app/dashboard/projects/export/route.ts                               (modified — swap to listProjectsForExport)
app/dashboard/tenders/export/route.ts                                (modified — swap to listTendersForExport)
app/dashboard/transactions/export/route.ts                           (modified — swap to listTransactionsForExport)
lib/projects/__tests__/list-visibility.test.ts                       (modified — +2 perPage cap tests)
lib/projects/actions.ts                                              (modified — +listProjectsForExport + inner helper)
lib/projects/schemas.ts                                              (modified — +listProjectsForExportQuerySchema)
lib/tenders/__tests__/list-visibility.test.ts                        (modified — +2 perPage cap tests)
lib/tenders/actions.ts                                               (modified — +listTendersForExport + inner helper)
lib/tenders/schemas.ts                                               (modified — +listTendersForExportQuerySchema)
lib/transactions/__tests__/list-actions.test.ts                      (modified — +2 perPage cap tests)
lib/transactions/actions.ts                                          (modified — +listTransactionsForExport + inner helper)
lib/transactions/schemas.ts                                          (modified — +listTransactionsForExportQuerySchema)

# Chunk 3 — Reports company-picker UX (commit 77286de)
app/dashboard/reports/_components/company-picker.tsx                 (new — URL-shaped picker)
app/dashboard/reports/page.tsx                                       (modified — fetch companies + mount picker)

# Day 20 report + Day 21 seed-plan (this commit)
docs/reports/day-20-report.md                                        (new)
docs/seed-plan.md                                                    (new — Day-21 UAT fixture buildout plan)
```

## Test totals

Before this session: **459 tests across 25 files**, all green (Day 19
end state).

After this session: **470 tests across 26 files**, all green every
run. Net: **+11**.

Breakdown of the delta:

- +5: `lib/reports/__tests__/pdf.test.ts` (Chunk 1, new file)
- +2: `lib/transactions/__tests__/list-actions.test.ts` (Chunk 2, appended)
- +2: `lib/projects/__tests__/list-visibility.test.ts` (Chunk 2, appended)
- +2: `lib/tenders/__tests__/list-visibility.test.ts` (Chunk 2, appended)
- +0: Chunk 3 (URL-shape change, behaviour covered by existing tests)

The brief budgeted ~6-12 new tests; landed at +11 — middle of range.

## Followups for Day 21+

**From this session:**

1. **Comprehensive UAT seed fixture buildout.** Carried into Day 21 per
   the original phase plan. `docs/seed-plan.md` lays out the target
   coverage: every status across every collection, MSME + non-MSME
   companies, mixed-status documents, every tender/application
   status, every project status, transactions across all 5 types
   spread across three months. Day 21 executes the lift inside
   `scripts/seed.ts` against the existing idempotency contract.
2. **Real Consultway logo on the PDF cover.** The cover uses a
   typographic wordmark today. When the brand asset lands in
   `public/logo.svg`, swap to `<Image src="public/logo.svg" ...>` in
   the `<Cover>` block. The rest of the layout stays unchanged.
3. **Charts in the HTML report cards.** Still deferred — a separate UX
   pass adds per-status sparklines / trend bars. The data layer is
   already shaped for it (period helpers take arbitrary
   `(start, end)`).
4. **Charts in the PDF.** Different story than HTML — PDF charts
   require either an SVG-rendered library or a server-side chart
   pre-render. Worth a separate session if charts ever land.
5. **Period-over-period comparison in the report.** Future session —
   the period helpers take arbitrary `(start, end)`, so adding a
   second "previous period" panel is a layout change, not a data-layer
   change.
6. **Streaming exports beyond 1000 rows.** The Day-20 lift just widened
   the cap from 100 to 1000; the actual streaming-cursor refactor is
   Phase-3 work (Phase-1 scale fits comfortably under 1000).
7. **Searchable typeahead selects on the project / transaction /
   tender forms AND the new reports company picker.** Carry-forward —
   Phase-1 scale doesn't need it.
8. **Per-document CSV export.** Separate session.
9. **Bulk CSV import.** Inverse of the export.
10. **Saved-report-config persistence.** Today the URL is the
    shareable form.

**Carried forward from Day 19 (unchanged):**

11. **Dashboard widget loading skeletons.** Lifting the dashboard's
    projects + tenders breakdown cards into their own `<Suspense>`
    boundaries.
12. **`deleteProject` action.** Carry-forward from Day 16. Needs its
    own confirm flow + R2-cleanup story + soft-delete-vs-hard-delete
    design pass.
13. **Project-attached documents.** Schema doesn't currently link
    documents to projects.
14. **Side-by-side detail view at desktop widths.** Project /
    transaction / company detail pages would benefit from a 3-column
    layout on `xl:` widths.
15. **`TransactionTypeBadge` / `ProjectStatusBadge` /
    `TenderStatusBadge` share a palette pattern.** Day 16/17/18/19/20
    all flagged this; still premature.
16. **`updateTransaction` audit `typeChange` only — `companyId` not
    patchable.** Followup if/when in-place re-tag becomes a real
    workflow need.

**Carried forward from Day 16 / 15 (unchanged):**

17. **Session invalidation on password reset.** Phase-3 hardening.
18. **Multi-step registration UX.** Wizard UI for `/register`.
19. **CAPTCHA / rate limiting** on `/register`, `/forgot-password`,
    token-consume endpoints.
20. **Public tender browsing.**
21. **Token cleanup cron.**
22. **Hoist `escapeHtml` to a shared helper.**
23. **`@opennextjs/cloudflare` install + `open-next.config.ts`.**
24. **D1-backed Drizzle client factory.**
25. **Resend domain verification + production secret.**
26. **Real Cloudflare D1 / R2 bucket UUIDs in `wrangler.jsonc`.**
27. **Seed self-healing on changed fixtures.**
28. **Stage real fixtures into R2.**

**Already-resolved this session:**

- Day-19 followup #1 (latent perPage cap on the CSV exporters) — Chunk 2.
- Day-19 followup #2 (PDF report generation) — Chunk 1.
- Day-19 followup #5 (`?companyId=` UX on the report) — Chunk 3.

## Carry-forward to Day 21

- **`dev` ended at 3 commits past Day-19's report commit (`d511402`)**
  before this report's own commit: `d9c790b` / `0790183` / `77286de`.
  Run `git log origin/dev..dev --oneline` for the up-to-date set —
  pushing still requires explicit approval per `<permissions>`.
- **470 tests passing on every run.** One new test file added
  (`lib/reports/__tests__/pdf.test.ts`); three existing test files
  appended with the perPage cap regression pairs.
- **Schema stays at migration 0012.** No new migration this session.
- **`pnpm cron:expiry-sweep`** still reports
  `remindersSkippedDeduped=1` — expected Day-12 dedup row.
- **`pnpm cron:pending-cleanup`** clean.
- **`RESEND_API_KEY` still empty** in `.env.local`. Day 20 didn't add
  new emails.
- **`PASSWORD_PEPPER`** unchanged.
- **One new dependency: `@react-pdf/renderer ^4.5.1`.** Pure JS,
  Workers-safe under `nodejs_compat`. First test run after `pnpm
  install` was clean.
- **`lib/reports/pdf.tsx` is the single source for PDF rendering.** A
  future "per-company PDF" or "monthly board pack" surface reuses
  `renderReportPdf` against the same input shape.
- **`/dashboard/reports/pdf` is admin/staff-only.** Company-role users
  get 403 (same gate as the HTML page's redirect; the PDF route stays a
  pure data download endpoint rather than redirecting).
- **`list*ForExport` is the export-only path.** The three CSV exporters
  + any future export consumer (Day-21-flagged per-document export,
  for example) should call these wrappers, not the strict `list*`.
- **`<EmptyState>` is now wired across every list page + the audit
  feed + the reports cards (Day-19).** Continued contract.
- **`docs/seed-plan.md` lays out Day-21's UAT fixture target.** The
  seed script lift starts there.

That's Day 20.
