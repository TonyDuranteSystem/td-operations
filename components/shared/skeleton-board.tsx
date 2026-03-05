export function SkeletonStats({ count = 3 }: { count?: number }) {
  return (
    <div className="flex gap-3 flex-wrap">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-white rounded-lg border p-4 flex-1 min-w-[120px] animate-pulse">
          <div className="h-7 w-20 bg-zinc-200 rounded mb-2" />
          <div className="h-3 w-28 bg-zinc-100 rounded" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonCard() {
  return (
    <div className="bg-white rounded-lg border p-3 animate-pulse">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-5 w-14 bg-zinc-200 rounded" />
        <div className="ml-auto h-4 w-10 bg-zinc-100 rounded" />
      </div>
      <div className="h-4 w-3/4 bg-zinc-200 rounded mb-1.5" />
      <div className="h-3 w-1/2 bg-zinc-100 rounded mb-2" />
      <div className="flex justify-between">
        <div className="h-3 w-16 bg-zinc-100 rounded" />
        <div className="h-3 w-12 bg-zinc-100 rounded" />
      </div>
    </div>
  )
}

export function SkeletonSection({ cards = 3 }: { cards?: number }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 py-3">
        <div className="h-4 w-4 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-28 bg-zinc-200 rounded animate-pulse" />
        <div className="h-5 w-8 bg-zinc-100 rounded-full animate-pulse" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pb-4">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  )
}

export function SkeletonTable({ rows = 8 }: { rows?: number }) {
  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <div className="hidden md:grid md:grid-cols-6 gap-3 px-4 py-2.5 border-b bg-zinc-50">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3 w-16 bg-zinc-200 rounded animate-pulse" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="grid grid-cols-1 md:grid-cols-6 gap-3 px-4 py-3 border-b last:border-b-0 animate-pulse">
          <div className="h-4 w-40 bg-zinc-200 rounded" />
          <div className="h-3 w-24 bg-zinc-100 rounded hidden md:block" />
          <div className="h-3 w-16 bg-zinc-100 rounded hidden md:block" />
          <div className="h-3 w-20 bg-zinc-100 rounded hidden md:block" />
          <div className="h-3 w-12 bg-zinc-100 rounded hidden md:block" />
          <div className="h-3 w-12 bg-zinc-100 rounded hidden md:block" />
        </div>
      ))}
    </div>
  )
}
