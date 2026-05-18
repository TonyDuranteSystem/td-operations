export default function Loading() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="animate-pulse">
        <div className="h-7 w-32 bg-zinc-200 rounded mb-3" />
        <div className="h-4 w-96 bg-zinc-200 rounded mb-6" />
        <div className="h-10 w-28 bg-zinc-200 rounded mb-4 ml-auto" />
        <div className="bg-white border rounded-lg">
          <div className="h-10 bg-zinc-50 border-b" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 border-b border-zinc-100" />
          ))}
        </div>
      </div>
    </div>
  )
}
