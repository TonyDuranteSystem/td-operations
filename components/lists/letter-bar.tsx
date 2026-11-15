'use client'

import { cn } from '@/lib/utils'
import { LETTERS, LETTER_OTHER } from '@/lib/crm-lists/letters'

/**
 * "Starts with" A to Z. A letter nobody starts with is greyed out; the numbers follow every other filter on the page.
 */
export function LetterBar({
  value,
  counts,
  onChange,
  disabled,
}: {
  value: string
  counts: { all: number; byLetter: Record<string, number> }
  onChange: (letter: string) => void
  disabled?: boolean
}) {
  const buttons = [...LETTERS, LETTER_OTHER]
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show names starting with">
      <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Starts with</span>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === ''}
        onClick={() => onChange('')}
        className={cn(
          'rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors',
          value === '' ? 'border-zinc-900 bg-zinc-900 text-white' : 'bg-white text-zinc-700 hover:bg-zinc-50',
        )}
      >
        All <span className={cn('ml-1 tabular-nums', value === '' ? 'opacity-70' : 'text-zinc-400')}>{counts.all}</span>
      </button>
      {buttons.map(l => {
        const n = counts.byLetter[l] ?? 0
        const on = value === l
        const empty = n === 0 && !on
        return (
          <button
            key={l}
            type="button"
            disabled={disabled || empty}
            aria-pressed={on}
            aria-label={`Names starting with ${l === LETTER_OTHER ? 'a number or symbol' : l}: ${n}`}
            onClick={() => onChange(on ? '' : l)}
            className={cn(
              'min-w-[28px] rounded-md border px-1.5 py-1 text-xs font-semibold tabular-nums transition-colors',
              on && 'border-zinc-900 bg-zinc-900 text-white',
              !on && !empty && 'bg-white text-zinc-800 hover:bg-zinc-50',
              empty && 'cursor-default border-dashed bg-white text-zinc-300',
            )}
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}
