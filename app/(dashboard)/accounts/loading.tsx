import { SkeletonTable } from '@/components/shared/skeleton-board'

export default function AccountsLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-32 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-56 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1 h-10 bg-white rounded-lg border animate-pulse" />
          <div className="h-10 w-28 bg-white rounded-lg border animate-pulse" />
          <div className="h-10 w-28 bg-white rounded-lg border animate-pulse" />
        </div>
        <SkeletonTable rows={12} />
      </div>
    </div>
  )
}
