export default function CalendarLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <div className="h-7 w-48 bg-zinc-200 rounded animate-pulse" />
        <div className="h-4 w-60 bg-zinc-100 rounded animate-pulse mt-2" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg border p-4 animate-pulse">
            <div className="h-5 w-20 bg-zinc-200 rounded mb-3" />
            <div className="flex gap-1">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="h-2.5 w-2.5 rounded-full bg-zinc-200" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
