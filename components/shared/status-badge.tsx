import { cn } from '@/lib/utils'
import { STATUS_COLORS } from '@/lib/constants'

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        STATUS_COLORS[status] ?? 'bg-zinc-100 text-zinc-800',
        className
      )}
    >
      {status}
    </span>
  )
}
