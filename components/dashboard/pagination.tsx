/**
 * Pagination control — Client Component.
 *
 * Renders Prev / 1 2 3 ... N / Next. Each page button is a Link that
 * preserves all OTHER search params and only changes `page`. This is
 * why we're a Client Component — we read `useSearchParams()` to merge.
 *
 * A pure server-side pagination would either lose filters or require
 * threading the entire searchParams object through props. Reading
 * useSearchParams() here keeps the calling Server Component clean.
 *
 * Module location: lives in `components/dashboard/` rather than under
 * any single feature's `_components/` folder because every list page
 * (companies, tenders, projects, transactions, …) needs the same
 * widget. Originally lived under the companies module; extracted in
 * the Day 4 tenders work so the second feature didn't have to copy it.
 *
 * Display rules:
 *   - totalPages <= 7: list them all (1 2 3 4 5 6 7)
 *   - Otherwise: 1, current-1, current, current+1, totalPages, with
 *     "…" filling gaps
 *
 * @module components/dashboard/pagination
 */
"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

// ── Props ─────────────────────────────────────────────────────────────────

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages available. */
  totalPages: number;
}

// ── Component ─────────────────────────────────────────────────────────────

export function Pagination({ page, totalPages }: PaginationProps) {
  const searchParams = useSearchParams();
  const pages = computePageWindow(page, totalPages);

  /**
   * Build href for a target page, preserving every other search param.
   * `page=1` is omitted (it's the default) so URLs stay clean.
   */
  function hrefForPage(target: number): string {
    const params = new URLSearchParams(searchParams.toString());
    if (target === 1) {
      params.delete("page");
    } else {
      params.set("page", String(target));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  }

  return (
    <nav className="flex items-center gap-1" aria-label="Pagination">
      <PageLink
        href={hrefForPage(page - 1)}
        disabled={page <= 1}
        label="Previous"
      >
        Previous
      </PageLink>

      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span
            key={`e-${i}`}
            className="px-2 text-muted-foreground"
            aria-hidden
          >
            …
          </span>
        ) : (
          <PageLink
            key={p}
            href={hrefForPage(p)}
            current={p === page}
            label={`Page ${p}`}
          >
            {p}
          </PageLink>
        ),
      )}

      <PageLink
        href={hrefForPage(page + 1)}
        disabled={page >= totalPages}
        label="Next"
      >
        Next
      </PageLink>
    </nav>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Decide which page numbers to show in the pagination strip.
 *
 *   totalPages ≤ 7 → list every page
 *   otherwise      → first + current±1 + last, gaps filled with "ellipsis"
 */
function computePageWindow(
  page: number,
  totalPages: number,
): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...set]
    .filter((n) => n >= 1 && n <= totalPages)
    .sort((a, b) => a - b);

  const result: Array<number | "ellipsis"> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push("ellipsis");
    }
    result.push(sorted[i]);
  }
  return result;
}

/**
 * Single page button. Three visual modes:
 *   - disabled (Prev on page 1, Next on last page) — non-clickable
 *   - current — Primary background, non-clickable
 *   - normal — outlined Link
 */
function PageLink({
  href,
  current,
  disabled,
  label,
  children,
}: {
  href: string;
  current?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const baseClasses =
    "inline-flex h-8 min-w-[2rem] items-center justify-center rounded-md border border-transparent px-2 text-sm transition-colors";

  if (disabled) {
    return (
      <span
        className={cn(baseClasses, "cursor-not-allowed text-muted-foreground/40")}
        aria-disabled
      >
        {children}
      </span>
    );
  }

  if (current) {
    return (
      <span
        className={cn(baseClasses, "bg-primary text-primary-foreground")}
        aria-current="page"
        aria-label={label}
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        baseClasses,
        "border-border text-foreground hover:bg-muted",
      )}
      aria-label={label}
    >
      {children}
    </Link>
  );
}
