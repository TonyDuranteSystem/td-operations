import { SkeletonStats, SkeletonSection } from '@/components/shared/skeleton-board'

export default function PipelineLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-36 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-60 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="space-y-6">
        <SkeletonStats count={3} />
        <SkeletonSection cards={4} />
        <SkeletonSection cards={3} />
      </div>
    </div>
  )
}
