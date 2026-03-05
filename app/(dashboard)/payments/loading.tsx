import { SkeletonStats, SkeletonTable } from '@/components/shared/skeleton-board'

export default function PaymentsLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-44 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-64 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="space-y-6">
        <SkeletonStats count={3} />
        <div className="flex gap-1 border-b pb-px">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-10 w-28 bg-zinc-100 rounded-t animate-pulse" />
          ))}
        </div>
        <SkeletonTable rows={10} />
      </div>
    </div>
  )
}
