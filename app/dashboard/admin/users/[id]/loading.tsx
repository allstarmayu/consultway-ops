/**
 * Loading state for the user detail page. Mirrors the header + fact-sheet
 * card shape so the page doesn't jump when content arrives.
 *
 * @module app/dashboard/admin/users/[id]/loading
 */
import { Card } from "@/components/ui/card";

export default function UserDetailLoading() {
  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="skeleton h-8 w-56" />
          <div className="skeleton h-4 w-64" />
          <div className="mt-1 flex gap-2">
            <div className="skeleton h-5 w-20" />
            <div className="skeleton h-5 w-20" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="skeleton h-9 w-20" />
          <div className="skeleton h-9 w-20" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="space-y-6 p-6 sm:p-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-4 w-full max-w-md" />
              <div className="skeleton h-4 w-full max-w-sm" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
