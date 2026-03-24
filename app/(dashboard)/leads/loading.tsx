export default function Loading() {
  return (
    <div className="p-6 lg:p-8 animate-pulse">
      <div className="h-8 w-32 bg-zinc-200 rounded mb-2" />
      <div className="h-4 w-64 bg-zinc-100 rounded mb-6" />
      <div className="h-10 bg-zinc-100 rounded-lg mb-4" />
      <div className="bg-white rounded-lg border">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b last:border-b-0">
            <div className="h-4 w-48 bg-zinc-100 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
