/**
 * Reports PDF — pure renderer that turns the same `(start, end, companyId)`
 * payload the HTML report consumes into a branded PDF buffer.
 *
 * Pure builder: takes the resolved period bounds + the three pre-fetched
 * aggregate results + an optional company name (when the report is
 * scoped) and returns a `Buffer` of PDF bytes via `@react-pdf/renderer`'s
 * `renderToBuffer`. No DB calls, no session reads — the route handler
 * (`app/dashboard/reports/pdf/route.ts`) does the auth gate and the
 * aggregate fetches, then hands the resolved payload here.
 *
 * Why this split:
 *   - The renderer is unit-testable in isolation (smoke-tested against
 *     a synthetic payload — no DB fixture needed for the rendering
 *     contract).
 *   - The route handler stays a thin shell around the existing aggregate
 *     helpers, so the HTML and PDF reports share the data layer
 *     character-for-character.
 *
 * Sections rendered:
 *   - Branded cover: title, period bounds, optional company name,
 *     generation timestamp.
 *   - Projects-created — per-status counts table.
 *   - Tenders-published — per-status counts table.
 *   - Transactions (admin role only) — per-type grid + grand total
 *     (ASCII rupees via `formatRupeesFromPaiseAscii` so the PDF text
 *     layer is grep-friendly and survives non-UTF-8-clean copy/paste).
 *   - Footer with page numbers.
 *
 * Cloudflare Workers compatibility: `@react-pdf/renderer` is pure JS
 * and works under the edge runtime with `nodejs_compat` (already on per
 * `wrangler.jsonc`). `renderToBuffer` is the `@platform node` API and
 * returns a `Buffer`; the route handler converts it to a `Uint8Array`
 * for the `NextResponse` body — `Response` accepts either, but
 * `Uint8Array` is the cross-runtime portable shape.
 *
 * @module lib/reports/pdf
 */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";

import {
  formatRupeesFromPaiseAscii,
} from "@/lib/format/inr";
import type {
  ProjectStatus,
  TenderStatus,
  TransactionType,
} from "@/lib/db/schema";

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Per-status / per-type rollup shape echoed from the aggregate helpers.
 * The renderer doesn't import the helpers' return types directly so the
 * builder stays consumable from anywhere without a sideways dependency.
 */
export interface ReportPdfInput {
  /** Inclusive period bounds, ISO date-only (`YYYY-MM-DD`). */
  start: string;
  end: string;
  /** Viewer role — gates the admin-only transactions section. */
  role: "admin" | "staff";
  /**
   * When the report is scoped to a single company, the company's display
   * name. Renders on the cover page; omitted line when the report covers
   * all companies.
   */
  companyName?: string;
  /** `getProjectsByStatusForPeriod` payload. */
  projects: {
    byStatus: Record<ProjectStatus, number>;
  };
  /** `getTendersByStatusForPeriod` payload. */
  tenders: {
    byStatus: Record<TenderStatus, number>;
  };
  /**
   * `getTransactionsSummaryForPeriod` payload. Omitted for staff role —
   * the transactions module is admin-only forever; staff PDFs render
   * everything except this section.
   */
  transactions?: {
    countByType: Record<TransactionType, number>;
    totalPaiseByType: Record<TransactionType, number>;
    totalPaise: number;
    totalCount: number;
  };
  /**
   * Generation timestamp echoed onto the cover. Defaults to the current
   * Date; override for deterministic tests.
   */
  generatedAt?: Date;
}

// ── Display order for the closed-set status keys ──────────────────────────

const PROJECT_STATUS_DISPLAY: Array<{ key: ProjectStatus; label: string }> = [
  { key: "planning", label: "Planning" },
  { key: "active", label: "Active" },
  { key: "on_hold", label: "On hold" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

const TENDER_STATUS_DISPLAY: Array<{ key: TenderStatus; label: string }> = [
  { key: "draft", label: "Draft" },
  { key: "published", label: "Published" },
  { key: "closed", label: "Closed" },
  { key: "awarded", label: "Awarded" },
];

const TRANSACTION_TYPE_DISPLAY: Array<{
  key: TransactionType;
  label: string;
}> = [
  { key: "invoice", label: "Invoice" },
  { key: "payment", label: "Payment" },
  { key: "expense", label: "Expense" },
  { key: "advance", label: "Advance" },
  { key: "refund", label: "Refund" },
];

// ── Stylesheet ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 56,
    paddingHorizontal: 48,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1f2937",
  },
  cover: {
    marginBottom: 28,
    borderBottomWidth: 1,
    borderBottomColor: "#d4a373",
    paddingBottom: 18,
  },
  brand: {
    fontSize: 11,
    letterSpacing: 1.5,
    color: "#9c4221",
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
  },
  title: {
    marginTop: 8,
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
  },
  coverMetaRow: {
    marginTop: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 24,
  },
  coverMetaCell: {
    minWidth: 140,
  },
  coverMetaLabel: {
    fontSize: 8,
    letterSpacing: 1,
    color: "#6b7280",
    textTransform: "uppercase",
  },
  coverMetaValue: {
    marginTop: 3,
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
  },
  section: {
    marginTop: 22,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
    marginBottom: 8,
  },
  table: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 4,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f9fafb",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  tableHeaderCell: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: "#374151",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  tableRowLast: {
    borderBottomWidth: 0,
  },
  tableCell: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 10,
    color: "#1f2937",
  },
  cellLabel: {
    flexGrow: 1,
  },
  cellCount: {
    width: 80,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
  },
  cellMoney: {
    width: 140,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
  },
  emptyRow: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    fontSize: 9,
    fontStyle: "italic",
    color: "#6b7280",
  },
  totalRow: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    paddingTop: 8,
  },
  totalLabel: {
    fontSize: 10,
    color: "#6b7280",
  },
  totalValue: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
  },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 48,
    right: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: "#9ca3af",
  },
});

// ── Components ────────────────────────────────────────────────────────────

interface CoverProps {
  title: string;
  start: string;
  end: string;
  companyName: string | undefined;
  generatedAt: Date;
}

function Cover({ title, start, end, companyName, generatedAt }: CoverProps) {
  return (
    <View style={styles.cover}>
      <Text style={styles.brand}>Consultway Infotech</Text>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.coverMetaRow}>
        <View style={styles.coverMetaCell}>
          <Text style={styles.coverMetaLabel}>Period</Text>
          <Text style={styles.coverMetaValue}>
            {start} → {end}
          </Text>
        </View>
        {companyName ? (
          <View style={styles.coverMetaCell}>
            <Text style={styles.coverMetaLabel}>Company</Text>
            <Text style={styles.coverMetaValue}>{companyName}</Text>
          </View>
        ) : (
          <View style={styles.coverMetaCell}>
            <Text style={styles.coverMetaLabel}>Scope</Text>
            <Text style={styles.coverMetaValue}>All companies</Text>
          </View>
        )}
        <View style={styles.coverMetaCell}>
          <Text style={styles.coverMetaLabel}>Generated</Text>
          <Text style={styles.coverMetaValue}>
            {generatedAt.toISOString().replace("T", " ").slice(0, 19)} UTC
          </Text>
        </View>
      </View>
    </View>
  );
}

interface CountsTableProps {
  title: string;
  emptyHint: string;
  rows: Array<{ label: string; count: number }>;
}

function CountsTable({ title, emptyHint, rows }: CountsTableProps) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const isEmpty = total === 0;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {title} — {total} total
      </Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, styles.cellLabel]}>Status</Text>
          <Text style={[styles.tableHeaderCell, styles.cellCount]}>Count</Text>
        </View>
        {isEmpty ? (
          <Text style={styles.emptyRow}>{emptyHint}</Text>
        ) : (
          rows.map((row, idx) => (
            <View
              key={row.label}
              style={[
                styles.tableRow,
                idx === rows.length - 1 ? styles.tableRowLast : {},
              ]}
            >
              <Text style={[styles.tableCell, styles.cellLabel]}>
                {row.label}
              </Text>
              <Text style={[styles.tableCell, styles.cellCount]}>
                {row.count}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

interface TransactionsTableProps {
  countByType: Record<TransactionType, number>;
  totalPaiseByType: Record<TransactionType, number>;
  totalPaise: number;
  totalCount: number;
}

function TransactionsTable({
  countByType,
  totalPaiseByType,
  totalPaise,
  totalCount,
}: TransactionsTableProps) {
  const isEmpty = totalCount === 0;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        Transactions — {totalCount} {totalCount === 1 ? "entry" : "entries"}
      </Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, styles.cellLabel]}>Type</Text>
          <Text style={[styles.tableHeaderCell, styles.cellCount]}>Count</Text>
          <Text style={[styles.tableHeaderCell, styles.cellMoney]}>
            Total (paise-exact)
          </Text>
        </View>
        {isEmpty ? (
          <Text style={styles.emptyRow}>No transactions in this period.</Text>
        ) : (
          TRANSACTION_TYPE_DISPLAY.map(({ key, label }, idx) => (
            <View
              key={key}
              style={[
                styles.tableRow,
                idx === TRANSACTION_TYPE_DISPLAY.length - 1
                  ? styles.tableRowLast
                  : {},
              ]}
            >
              <Text style={[styles.tableCell, styles.cellLabel]}>{label}</Text>
              <Text style={[styles.tableCell, styles.cellCount]}>
                {countByType[key] ?? 0}
              </Text>
              <Text style={[styles.tableCell, styles.cellMoney]}>
                {formatRupeesFromPaiseAscii(totalPaiseByType[key] ?? 0)}
              </Text>
            </View>
          ))
        )}
      </View>
      {!isEmpty && (
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Grand total</Text>
          <Text style={styles.totalValue}>
            {formatRupeesFromPaiseAscii(totalPaise)}
          </Text>
        </View>
      )}
    </View>
  );
}

function ReportDocument({
  start,
  end,
  role,
  companyName,
  projects,
  tenders,
  transactions,
  generatedAt,
}: Required<Omit<ReportPdfInput, "companyName" | "transactions">> &
  Pick<ReportPdfInput, "companyName" | "transactions">) {
  return (
    <Document
      title={`Consultway report ${start} to ${end}`}
      author="Consultway Infotech"
      creator="Consultway Ops portal"
      producer="@react-pdf/renderer"
    >
      <Page size="A4" style={styles.page}>
        <Cover
          title="Operations & Financial Summary"
          start={start}
          end={end}
          companyName={companyName}
          generatedAt={generatedAt}
        />

        <CountsTable
          title="Projects created"
          emptyHint="No projects created in this period."
          rows={PROJECT_STATUS_DISPLAY.map(({ key, label }) => ({
            label,
            count: projects.byStatus[key] ?? 0,
          }))}
        />

        <CountsTable
          title="Tenders published"
          emptyHint="No tenders published in this period."
          rows={TENDER_STATUS_DISPLAY.map(({ key, label }) => ({
            label,
            count: tenders.byStatus[key] ?? 0,
          }))}
        />

        {role === "admin" && transactions && (
          <TransactionsTable
            countByType={transactions.countByType}
            totalPaiseByType={transactions.totalPaiseByType}
            totalPaise={transactions.totalPaise}
            totalCount={transactions.totalCount}
          />
        )}

        <View style={styles.footer} fixed>
          <Text>Consultway Infotech — operations report</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Render the report payload to a PDF byte buffer. Returns a `Uint8Array`
 * so the call-site doesn't have to import `Buffer` from `node:buffer`
 * (the route handler hands it straight to `NextResponse`).
 *
 * Throws if `@react-pdf/renderer` itself rejects (PDF generation is
 * synchronous-feeling but the API is `Promise<Buffer>`). The route
 * handler converts the thrown error into a 500.
 */
export async function renderReportPdf(
  input: ReportPdfInput,
): Promise<Uint8Array<ArrayBuffer>> {
  const generatedAt = input.generatedAt ?? new Date();
  const element = (
    <ReportDocument
      start={input.start}
      end={input.end}
      role={input.role}
      companyName={input.companyName}
      projects={input.projects}
      tenders={input.tenders}
      transactions={input.transactions}
      generatedAt={generatedAt}
    />
  );

  const buffer = await renderToBuffer(element);
  // Copy into a fresh `Uint8Array<ArrayBuffer>` — Node's Buffer is
  // `Uint8Array<ArrayBufferLike>`, which the current TS `BodyInit` typing
  // refuses. Allocating a new `ArrayBuffer` and `.set()`-ing the bytes
  // strips the `Like` and gives the call-site a portable shape.
  const out = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  out.set(buffer);
  return out;
}
