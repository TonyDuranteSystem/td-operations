'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Instant-appearing hover label — the browser's native `title` attribute has
 * a ~1.5s+ built-in delay before it shows, which reads as "broken" on a
 * single click target like an icon button. This appears on the same frame
 * as the hover instead.
 *
 * Mouse-hover is gated on genuine hover capability (`hover: hover` +
 * `pointer: fine`): a plain CSS `:hover` trigger also fires on a phone tap
 * in many mobile browsers with no matching "leave" event, leaving the label
 * stuck open over live content until the next unrelated tap (found live on
 * this exact component during council review, dev job 06e57270). Keyboard
 * focus is never gated — a real Tab lands and leaves cleanly regardless of
 * pointer type. The label is purely a sighted-mouse convenience; the
 * accessible name for assistive tech comes from the wrapped element's own
 * `aria-label`, untouched by this component either way.
 */
export function FastTooltip({
  label,
  children,
  align = 'right',
  className,
}: {
  /** Falsy (empty string / undefined) renders no label at all — e.g. a
   * `title={cond ? 'reason' : undefined}` conditional-explanation pattern
   * passed straight through shows nothing when the condition is false,
   * matching the original native-title behavior instead of an empty bubble. */
  label: string | undefined
  children: React.ReactNode
  align?: 'left' | 'right' | 'center'
  /**
   * Extra classes for the wrapper div, merged after the base `relative
   * inline-flex`. Needed when the wrapped element relies on a sizing
   * behavior (`w-full`, `flex-1`, …) that only works if its immediate
   * parent shares it — e.g. a full-width list row or an equal-share tab
   * in a flex bar. Leave unset for a plain icon/button wrap.
   */
  className?: string
}) {
  const [show, setShow] = useState(false)
  const [canHover, setCanHover] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    setCanHover(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setCanHover(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return (
    <div
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => canHover && setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      onClick={() => setShow(false)}
    >
      {children}
      {show && label && (
        <span
          className={cn(
            'pointer-events-none absolute top-full z-20 mt-1 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs text-white',
            align === 'left' && 'left-0',
            align === 'right' && 'right-0',
            align === 'center' && 'left-1/2 -translate-x-1/2'
          )}
        >
          {label}
        </span>
      )}
    </div>
  )
}
