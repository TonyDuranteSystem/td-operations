'use client'

/**
 * HelpDot — drop <HelpDot helpKey="board.snooze" /> next to any control. Shows a
 * small "i" ONLY when the global Help toggle is on AND content exists for the key
 * (missing keys never clutter). Hover/click shows three short lines: what it does
 * / what happens when you click / what's next.
 *
 * The popover is PORTALED to <body> with fixed positioning so it never gets
 * clipped by scroll/overflow containers (e.g. the horizontally-scrolling board).
 * Content comes from HelpProvider's in-memory map (one fetch/session). Staff-only
 * by living in dashboard components. See sysdoc help-system-plan.
 */

import { Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { useHelp } from './help-provider'

const POPOVER_W = 256

export function HelpDot({ helpKey, className }: { helpKey: string; className?: string }) {
  const { helpOn, get } = useHelp()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    let left = r.left + r.width / 2 - POPOVER_W / 2
    left = Math.max(8, Math.min(left, window.innerWidth - POPOVER_W - 8))
    setCoords({ top: r.bottom + 6, left })
  }, [])

  const show = useCallback(() => { place(); setOpen(true) }, [place])
  const hide = useCallback(() => setOpen(false), [])

  // Close on outside click + on scroll/resize (fixed position would detach).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  if (!helpOn) return null
  const entry = get(helpKey)
  if (!entry) return null

  return (
    <span className={cn('inline-flex align-middle', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); open ? hide() : show() }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className="p-0.5 rounded-full text-violet-500 hover:text-violet-700 hover:bg-violet-50 focus:outline-none focus:ring-1 focus:ring-violet-300"
        aria-label={`Help: ${entry.title}`}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: POPOVER_W, zIndex: 9999 }}
          className="rounded-lg bg-white p-3 text-left shadow-xl border border-zinc-200"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs font-semibold text-zinc-900 mb-1.5">{entry.title}</p>
          {entry.what && <Section label="What it does" text={entry.what} />}
          {entry.on_click && <Section label="When you click" text={entry.on_click} />}
          {entry.next && <Section label="What's next" text={entry.next} />}
        </div>,
        document.body,
      )}
    </span>
  )
}

function Section({ label, text }: { label: string; text: string }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-500">{label}</p>
      <p className="text-xs text-zinc-600 leading-snug">{text}</p>
    </div>
  )
}
