'use client'

/**
 * InvoiceNoteDot — small amber note icon shown next to an invoice's status when
 * the invoice carries an internal note (`payments.notes`). Hover/click opens a
 * popover with the note text so staff see context (e.g. "client promised to
 * pay in September") BEFORE sending a reminder — without cluttering the row.
 *
 * The popover is PORTALED to <body> with fixed positioning (same pattern as
 * components/help/help-dot.tsx) so it never gets clipped by the invoice
 * table's overflow-auto container.
 *
 * Staff-only by living in dashboard components. The note itself is internal —
 * it is never rendered in the portal or copied to client-domain tables.
 */

import { StickyNote } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

const POPOVER_W = 288

export function InvoiceNoteDot({ note, className }: { note: string | null | undefined; className?: string }) {
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

  if (!note?.trim()) return null

  return (
    <span className={cn('inline-flex align-middle', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (open) { hide() } else { show() } }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className="p-0.5 rounded-full text-amber-500 hover:text-amber-700 hover:bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300"
        aria-label="Internal note"
      >
        <StickyNote className="h-3.5 w-3.5" />
      </button>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: POPOVER_W, zIndex: 9999 }}
          className="rounded-lg bg-white p-3 text-left shadow-xl border border-amber-200"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 mb-1">Internal note</p>
          <p className="text-xs text-zinc-700 leading-snug whitespace-pre-wrap">{note}</p>
        </div>,
        document.body,
      )}
    </span>
  )
}
