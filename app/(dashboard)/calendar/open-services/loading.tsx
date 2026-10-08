export default function OpenServicesLoading() {
  return (
    <div className="p-6 lg:p-8" aria-busy="true" aria-live="polite">
      <div className="mb-6">
        <div className="h-7 w-48 animate-pulse rounded bg-zinc-200" />
        <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-zinc-100" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-zinc-50" />
        ))}
      </div>
    </div>
  )
}
