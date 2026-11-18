'use client'

import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * The one shared "must read" warning (dev job beb43385).
 *
 * Antonio, 2026-11-17: "people are lazy, they don't read important stuff if it is small or
 * not evident. They must be evident, a small 'I read it' check and big red wording:
 * Read well before proceeding."
 *
 * Big red block, big title, readable body text, and an "I read it" tick that the caller uses
 * to unlock its button. Build every important warning from THIS block so they all look the
 * same. The wording is passed in already translated; this component holds no copy of its own.
 *
 * The existing small red alert (wizard field `danger`) and the small amber tick (team invite)
 * are older patterns and are left alone.
 */
export interface MustReadBlockProps {
  /** The big red title, e.g. "Read well before proceeding." (already translated). */
  title: string
  /** The message. Put the key sentence in <strong>. */
  children: React.ReactNode
  /** The words next to the tick, e.g. "I read it" (already translated). */
  ackLabel: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Draw the block as "not ticked yet, and the client tried to go on". */
  invalid?: boolean
  className?: string
}

export function MustReadBlock({ title, children, ackLabel, checked, onCheckedChange, invalid = false, className }: MustReadBlockProps) {
  const titleId = useId()
  const tickId = useId()
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-must-read
      className={cn(
        'rounded-xl border-2 border-red-600 bg-red-50 p-4 space-y-3',
        invalid && !checked && 'ring-4 ring-red-300',
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-white text-xl font-black leading-none"
        >
          !
        </span>
        <p id={titleId} className="text-xl font-extrabold tracking-tight text-red-700">{title}</p>
      </div>
      <div className="space-y-2 text-[15px] leading-relaxed text-red-950">{children}</div>
      <label
        htmlFor={tickId}
        className={cn(
          'flex items-center gap-3 rounded-lg border-2 bg-white px-3.5 py-2.5 text-base font-bold text-zinc-900 cursor-pointer select-none',
          checked ? 'border-red-600' : 'border-red-300',
        )}
      >
        <input
          id={tickId}
          type="checkbox"
          checked={checked}
          onChange={e => onCheckedChange(e.target.checked)}
          className="h-6 w-6 shrink-0 cursor-pointer accent-red-600"
        />
        <span>{ackLabel}</span>
      </label>
    </div>
  )
}
