export default function AuditLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-32 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-64 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="space-y-4">
        {/* Stats skeleton */}
        <div className="flex gap-3 flex-wrap">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-lg border p-4 flex-1 min-w-[100px] animate-pulse">
              <div className="h-7 w-12 bg-zinc-200 rounded mb-2" />
              <div className="h-3 w-16 bg-zinc-100 rounded" />
            </div>
          ))}
        </div>
        {/* Filters skeleton */}
        <div className="flex gap-3">
          <div className="flex-1 h-10 bg-zinc-100 rounded-lg animate-pulse" />
          <div className="w-32 h-10 bg-zinc-100 rounded-lg animate-pulse" />
          <div className="w-32 h-10 bg-zinc-100 rounded-lg animate-pulse" />
          <div className="w-28 h-10 bg-zinc-100 rounded-lg animate-pulse" />
        </div>
        {/* Table skeleton */}
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="h-10 bg-zinc-50 border-b" />
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="px-4 py-3 border-b animate-pulse">
              <div className="h-4 bg-zinc-100 rounded w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
