'use client'

import { cn } from '@/lib/utils'

export interface SegmentedOption {
  value: string
  label: string
  /** The cross-filtered count shown next to the choice (how many rows you would get if you picked it). */
  count?: number
}

/** A row of exclusive choices with a small count on each — the filter style used on the Accounts and Contacts lists. */
export function SegmentedFilter({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2" role="group" aria-label={label}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="inline-flex min-w-0 max-w-full overflow-x-auto rounded-lg border bg-white text-xs">
        {options.map((o, i) => {
          const on = o.value === value
          return (
            <button
              key={o.value || 'all'}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onChange(o.value)}
              className={cn(
                'whitespace-nowrap px-2.5 py-1.5 transition-colors',
                i > 0 && 'border-l',
                on ? 'bg-zinc-900 font-semibold text-white' : 'text-zinc-600 hover:bg-zinc-50',
              )}
            >
              {o.label}
              {o.count != null && <span className={cn('ml-1.5 tabular-nums', on ? 'opacity-70' : 'text-zinc-400')}>{o.count}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
