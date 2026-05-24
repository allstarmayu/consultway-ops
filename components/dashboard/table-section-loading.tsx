/**
 * Generic skeleton fallback for any dashboard list table.
 *
 * Renders N rows × M columns of pulsing rectangles, matching the
 * standard table header → body → pagination geometry used by the
 * companies and tenders list pages. Same Card boundary as the
 * populated table so the surrounding page layout doesn't shift.
 *
 * Used as the Suspense fallback for `<CompaniesTableSection />` and
 * `<TendersTableSection />` - any list page whose body streams its
 * rows independently of the page header and filter bar.
 *
 * @module components/dashboard/table-section-loading
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface TableSectionLoadingProps {
  /**
   * Number of header / body columns. Companies + tenders both use
   * around 6-7. The skeleton doesn't need to be column-exact - it's
   * a loading affordance, not a perfect ghost.
   */
  columns?: number;

  /**
   * Number of skeleton rows. Should approximate the typical page
   * size (default 6 - matches the typical visible window without
   * implying a specific total count).
   */
  rows?: number;
}

export function TableSectionLoading({
  columns = 6,
  rows = 6,
}: TableSectionLoadingProps) {
  return (
    <div aria-busy="true" aria-live="polite">
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: columns }).map((_, i) => (
              <TableHead key={i}>
                <div className="skeleton h-4 w-20" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, rowIdx) => (
            <TableRow key={rowIdx}>
              {Array.from({ length: columns }).map((__, colIdx) => (
                <TableCell key={colIdx}>
                  <div
                    className="skeleton h-4"
                    // Slight width variation so the skeleton doesn't
                    // look like a perfect grid - more believable.
                    style={{
                      width: `${60 + ((rowIdx * 7 + colIdx * 13) % 4) * 10}%`,
                    }}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination strip placeholder so the card height settles in
          one shot rather than jumping again when rows arrive. */}
      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <div className="skeleton h-3 w-40" />
        <div className="flex items-center gap-2">
          <div className="skeleton h-8 w-20" />
          <div className="skeleton h-8 w-20" />
        </div>
      </div>
    </div>
  );
}
