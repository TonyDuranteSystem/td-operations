'use client'

import { useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SWIPE_BUTTON_PX, isHorizontalDrag, revealedSide, rowOffset, settleState, type SwipeState } from '@/lib/portal-chats/row-swipe'

export interface SwipeAction {
  key: string
  label: string
  icon: ReactNode
  className: string
  onPress: () => void
}

/**
 * A conversation row you can swipe on a phone (staff Portal Chats list). Swipe right shows `leftActions`, swipe left shows `rightActions`.
 * Touch only — a mouse never swipes, so the computer list is unchanged. While a row is open, a tap on it closes it instead of opening
 * the chat. Only one row is open at a time (`openKey` / `onOpenChange` live in the list).
 */
export function SwipeRow({ rowKey, openKey, onOpenChange, leftActions, rightActions, className, children }: {
  rowKey: string
  openKey: string | null
  onOpenChange: (key: string | null) => void
  leftActions: SwipeAction[]
  rightActions: SwipeAction[]
  className?: string
  children: ReactNode
}) {
  const state: SwipeState = openKey?.startsWith(`${rowKey}|`) ? (openKey.endsWith('|left') ? 'left' : 'right') : 'closed'
  const [drag, setDrag] = useState<number | null>(null) // live offset while a finger is down
  const touch = useRef<{ x: number; y: number; horizontal: boolean; dx: number } | null>(null)
  const swallowClick = useRef(false)

  const offset = drag ?? rowOffset(state, 0)
  const side = revealedSide(offset)

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    touch.current = { x: t.clientX, y: t.clientY, horizontal: false, dx: 0 }
  }
  function onTouchMove(e: React.TouchEvent) {
    const p = touch.current
    if (!p) return
    const t = e.touches[0]
    const dx = t.clientX - p.x
    const dy = t.clientY - p.y
    if (!p.horizontal) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { touch.current = null; return } // it is a scroll
      if (!isHorizontalDrag(dx, dy)) return
      p.horizontal = true
    }
    p.dx = dx
    setDrag(rowOffset(state, dx))
  }
  function onTouchEnd() {
    const p = touch.current
    touch.current = null
    if (!p?.horizontal) { setDrag(null); return }
    swallowClick.current = true
    setTimeout(() => { swallowClick.current = false }, 350)
    const next = settleState(state, p.dx)
    setDrag(null)
    onOpenChange(next === 'closed' ? null : `${rowKey}|${next}`)
  }
  function onClickCapture(e: React.MouseEvent) {
    if (swallowClick.current) { e.preventDefault(); e.stopPropagation(); return }
    if (state !== 'closed') { e.preventDefault(); e.stopPropagation(); onOpenChange(null) } // a tap on an open row just closes it
  }

  const actions = side === 'left' ? leftActions : side === 'right' ? rightActions : []
  return (
    <div className={cn('relative overflow-hidden', className)} data-testid="swipe-row" data-swipe-state={state}>
      {side && (
        <div className={cn('absolute inset-y-0 flex', side === 'left' ? 'left-0' : 'right-0')} style={{ width: SWIPE_BUTTON_PX * actions.length }}>
          {actions.map(a => (
            <button
              key={a.key}
              type="button"
              data-testid={`swipe-action-${a.key}`}
              onClick={() => { a.onPress(); onOpenChange(null) }}
              className={cn('flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-white', a.className)}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      )}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={onClickCapture}
        style={{ transform: `translateX(${offset}px)`, transition: drag === null ? 'transform 180ms ease-out' : 'none' }}
        className="relative bg-white"
      >
        {children}
      </div>
    </div>
  )
}
