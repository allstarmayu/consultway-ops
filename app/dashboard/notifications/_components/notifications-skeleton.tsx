/**
 * Skeleton rows for the notifications feed — shared by `loading.tsx` and the
 * page's Suspense fallback so the shimmer shape matches the real list and the
 * layout doesn't jump when content arrives. Uses the `.skeleton` shimmer
 * utility (same as the other list loaders).
 *
 * @module app/dashboard/notifications/_components/notifications-skeleton
 */
export function NotificationsSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <div className="skeleton h-8 w-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
