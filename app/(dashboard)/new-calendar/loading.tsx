export default function NewCalendarLoading() {
  return (
    <div className="p-6 lg:p-8" aria-busy="true" aria-live="polite">
      <div className="mb-6">
        <div className="h-7 w-48 animate-pulse rounded bg-zinc-200" />
        <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-zinc-100" />
      </div>
      <div className="mb-4 flex gap-2">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-8 w-32 animate-pulse rounded-full bg-zinc-100" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border bg-zinc-50" />
    </div>
  )
}
