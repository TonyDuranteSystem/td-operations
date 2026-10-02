'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { tooltipPosition, type TooltipPosition } from '@/lib/ui/tooltip-position'

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
 *
 * The label is rendered in a body-level portal with `position: fixed` — NOT
 * inside the wrapper. Inside a clipped/scrolling box (a table in
 * `overflow-x-auto`) a label under the bottom row used to spill past the box,
 * add a scrollbar, shift the layout off the cursor, hide itself, and repeat —
 * an endless flicker. A fixed label takes no part in any container's layout.
 * It hides on scroll/resize so it can never be left floating in the wrong place.
 */
/** Above every overlay in the app (the highest existing layer is 10000): the
 * label now lives at body level, so a modal at z-70/80/100 would otherwise
 * cover the label of its own buttons. It is pointer-events:none, so sitting on
 * top of everything can never block a click. */
const TOOLTIP_Z_INDEX = 10001

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
  const [pos, setPos] = useState<TooltipPosition | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const open = () => {
    const r = wrapperRef.current?.getBoundingClientRect()
    if (r) setPos(tooltipPosition(r, align, window.innerHeight))
    setShow(true)
  }

  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    setCanHover(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setCanHover(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!show) return
    const hide = () => setShow(false)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [show])

  return (
    <div
      ref={wrapperRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => canHover && open()}
      onMouseLeave={() => setShow(false)}
      onFocus={open}
      onBlur={() => setShow(false)}
      onClick={() => setShow(false)}
    >
      {children}
      {show && label && pos && typeof document !== 'undefined' &&
        createPortal(
          <span
            role="tooltip"
            style={{ position: 'fixed', top: pos.top, left: pos.left, transform: `translate(${pos.translateX}, ${pos.translateY})`, zIndex: TOOLTIP_Z_INDEX }}
            className="pointer-events-none whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs text-white"
          >
            {label}
          </span>,
          document.body
        )}
    </div>
  )
}
