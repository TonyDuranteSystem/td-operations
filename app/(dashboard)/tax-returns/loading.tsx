import { SkeletonStats, SkeletonSection } from '@/components/shared/skeleton-board'

export default function TaxReturnsLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-52 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-80 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="space-y-6">
        <SkeletonStats count={6} />
        <SkeletonSection cards={5} />
        <SkeletonSection cards={4} />
        <SkeletonSection cards={3} />
      </div>
    </div>
  )
}
