'use client'

import { useEffect, useRef } from 'react'

/**
 * The glowing ring a guided tour draws around the thing to click — shared by the floating-windows tour and the workspace guide.
 * NON-blocking on purpose (pointer-events none, no screen dimming): the person must be able to click the very thing it circles. It follows the
 * target as the page moves (a polling frame loop), scrolls it into view once per step, hides when the target is not on the page, and reports
 * whether something (a window, the card) is sitting on top of the circled spot so the card can say so.
 */
export function TourRing({ selector, stepKey, onCovered }: { selector: string | null; stepKey: string; onCovered: (covered: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string>('')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    onCovered(false) // a new target starts uncovered until we have looked
    if (!selector) {
      el.style.display = 'none'
      return
    }
    let raf = 0
    let last = ''
    let lastCovered = false
    const tick = () => {
      const target = document.querySelector(selector)
      if (!target) {
        if (last !== 'none') {
          el.style.display = 'none'
          last = 'none'
        }
        if (lastCovered) {
          lastCovered = false
          onCovered(false)
        }
      } else {
        // A target far down the left menu would otherwise be out of sight: bring it into view once per step.
        const key = `${stepKey}|${selector}`
        if (scrolledFor.current !== key) {
          scrolledFor.current = key
          ;(target as HTMLElement).scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
        }
        const r = target.getBoundingClientRect()
        const next = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
        if (r.width < 1 || r.height < 1) {
          if (last !== 'none') {
            el.style.display = 'none'
            last = 'none'
          }
        } else if (next !== last) {
          last = next
          el.style.display = 'block'
          el.style.left = `${r.left - 4}px`
          el.style.top = `${r.top - 4}px`
          el.style.width = `${r.width + 8}px`
          el.style.height = `${r.height + 8}px`
        }
        // Is something (a window, the card) sitting on top of the circled spot, so it can't be clicked?
        if (r.width >= 1 && r.height >= 1) {
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          const isCovered = !!top && !target.contains(top) && !top.contains(target)
          if (isCovered !== lastCovered) {
            lastCovered = isCovered
            onCovered(isCovered)
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [selector, stepKey, onCovered])

  return (
    <div
      ref={ref}
      aria-hidden
      data-tour-ring=""
      className="pointer-events-none fixed z-[48] hidden rounded-lg border-2 border-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.25)] motion-safe:animate-pulse"
    />
  )
}
