import { SkeletonStats, SkeletonSection } from '@/components/shared/skeleton-board'

export default function ServicesLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-44 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-72 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="space-y-6">
        <SkeletonStats count={5} />
        <SkeletonSection cards={6} />
        <SkeletonSection cards={4} />
      </div>
    </div>
  )
}
