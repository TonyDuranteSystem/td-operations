export function CardSkeleton({ title }: { title?: string }) {
  return (
    <div className="bg-white rounded-lg border p-5 animate-pulse">
      {title && (
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </div>
      )}
      <div className="space-y-3">
        <div className="h-4 bg-zinc-100 rounded w-3/4" />
        <div className="h-4 bg-zinc-100 rounded w-1/2" />
        <div className="h-4 bg-zinc-100 rounded w-2/3" />
      </div>
    </div>
  )
}
