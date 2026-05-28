'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Collapsible long text. Clamps to `lines` by default so a long note can't
 * dominate the page, and shows a "Show more / Show less" toggle ONLY when the
 * text actually overflows the clamp. Used for To-Do / board card notes.
 */
export function ExpandableText({
  text,
  lines = 2,
  className,
  textClassName,
  moreLabel = 'Show more',
  lessLabel = 'Show less',
}: {
  text: string
  lines?: number
  className?: string
  textClassName?: string
  moreLabel?: string
  lessLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)

  // Measure in the COLLAPSED state (the clamp styles are applied while not
  // expanded), so scrollHeight > clientHeight tells us a toggle is needed.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [text, lines, expanded])

  return (
    <div className={className}>
      <p
        ref={ref}
        className={cn('break-words whitespace-pre-wrap', textClassName)}
        style={
          expanded
            ? undefined
            : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
        }
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-0.5 text-[10px] font-semibold text-violet-600 hover:text-violet-800"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  )
}
