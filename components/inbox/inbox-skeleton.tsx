export function InboxSkeleton() {
  return (
    <div className="flex h-full animate-pulse">
      {/* Left panel skeleton */}
      <div className="w-full lg:w-[350px] border-r">
        <div className="h-12 border-b bg-zinc-100" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b">
            <div className="h-4 bg-zinc-200 rounded w-2/3 mb-2" />
            <div className="h-3 bg-zinc-100 rounded w-full" />
          </div>
        ))}
      </div>

      {/* Right panel skeleton */}
      <div className="hidden lg:flex flex-1 flex-col">
        <div className="h-14 border-b bg-zinc-50" />
        <div className="flex-1 p-4 space-y-4">
          <div className="flex justify-start">
            <div className="h-16 bg-zinc-100 rounded-2xl w-1/2" />
          </div>
          <div className="flex justify-end">
            <div className="h-12 bg-blue-100 rounded-2xl w-1/3" />
          </div>
          <div className="flex justify-start">
            <div className="h-20 bg-zinc-100 rounded-2xl w-2/3" />
          </div>
        </div>
        <div className="h-16 border-t bg-zinc-50" />
      </div>
    </div>
  )
}
