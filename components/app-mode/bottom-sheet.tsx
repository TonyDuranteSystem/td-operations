'use client'

// A bottom sheet for the TD Social phone app (dev job 2072bc3e). It is only ever rendered by screens that already checked `useAppMode()`,
// so the computer CRM never shows it. Attached to the page root (a portal), like the other pop-ups, so the app-only size rules reach it.
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => { if (open) panel.current?.focus() }, [open])

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[100]" data-testid="bottom-sheet">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/35" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Menu'}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-2xl bg-white pb-[max(16px,env(safe-area-inset-bottom))] shadow-2xl outline-none"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-zinc-300" />
        {title && <p className="px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</p>}
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function SheetHeading({ children }: { children: ReactNode }) {
  return <p className="border-t border-zinc-100 px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">{children}</p>
}

export function SheetRow({ label, hint, badge, checked, danger, disabled, onClick }: {
  label: ReactNode
  hint?: ReactNode
  badge?: number
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={checked === undefined ? undefined : checked}
      className={cn(
        'flex w-full items-center justify-between gap-3 border-t border-zinc-100 px-5 py-2 text-left text-base disabled:opacity-50',
        checked ? 'bg-blue-50' : 'active:bg-zinc-50',
        danger ? 'text-red-600' : 'text-zinc-900',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-sm text-zinc-500">{hint}</span>}
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white">{badge > 999 ? '999+' : badge}</span>
      )}
      {checked && <Check className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />}
    </button>
  )
}
