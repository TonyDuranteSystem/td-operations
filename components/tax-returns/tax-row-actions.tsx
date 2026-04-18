'use client'

/**
 * P3.9 — row-level action menu for tax return cards on /tax-returns.
 *
 * TaxCard already exposes click-to-edit + paid/data/india toggle chips.
 * This menu adds:
 *   • Set status to any tax_return_status value (11 options)
 *   • Delete (with P3.7 preview, blocked on "TR Filed")
 *
 * Same portal + flip-above pattern as PaymentRowActions / TaskRowActions.
 */

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  MoreVertical,
  Loader2,
  Trash2,
  Circle,
} from 'lucide-react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import {
  updateTaxReturnStatus,
  deleteTaxReturn,
  deleteTaxReturnPreview,
} from '@/app/(dashboard)/tax-returns/actions'
import type { TaxReturn } from '@/lib/types'

const TAX_STATUSES = [
  'Payment Pending',
  'Not Invoiced',
  'Paid - Not Started',
  'Activated - Need Link',
  'Link Sent - Awaiting Data',
  'Data Received',
  'Sent to India',
  'Extension Requested',
  'Extension Filed',
  'TR Completed - Awaiting Signature',
  'TR Filed',
] as const

const STATUS_DOT: Record<string, string> = {
  'Payment Pending': 'text-amber-500',
  'Not Invoiced': 'text-zinc-400',
  'Paid - Not Started': 'text-zinc-500',
  'Activated - Need Link': 'text-blue-400',
  'Link Sent - Awaiting Data': 'text-blue-500',
  'Data Received': 'text-indigo-500',
  'Sent to India': 'text-violet-500',
  'Extension Requested': 'text-orange-400',
  'Extension Filed': 'text-orange-500',
  'TR Completed - Awaiting Signature': 'text-emerald-400',
  'TR Filed': 'text-emerald-600',
}

interface Props {
  taxReturn: TaxReturn
}

export function TaxRowActions({ taxReturn: tr }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const positionMenu = () => {
    if (!buttonRef.current) return
    const btn = buttonRef.current.getBoundingClientRect()
    const menuWidth = 240
    const menuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, 420)
    const gap = 4
    const margin = 8

    let top = btn.bottom + gap
    let left = btn.right - menuWidth

    if (top + menuHeight + margin > window.innerHeight) {
      const flippedTop = btn.top - menuHeight - gap
      if (flippedTop >= margin) {
        top = flippedTop
      } else {
        top = Math.max(margin, window.innerHeight - menuHeight - margin)
      }
    }
    if (left + menuWidth + margin > window.innerWidth) {
      left = window.innerWidth - menuWidth - margin
    }
    if (left < margin) left = margin

    setMenuPos({ top, left })
  }

  useLayoutEffect(() => {
    if (!menuOpen) return
    positionMenu()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const handler = () => positionMenu()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler is stable enough
  }, [menuOpen])

  const handleSetStatus = (status: string) => {
    if (status === tr.status) { setMenuOpen(false); return }
    setMenuOpen(false)
    startTransition(async () => {
      const result = await updateTaxReturnStatus(tr.id, status, tr.updated_at)
      if (result.success) {
        toast.success(`Status \u2192 ${status}`)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Failed to update status')
      }
    })
  }

  const handleDeleteConfirm = async () => {
    const result = await deleteTaxReturn(tr.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: 'Tax return deleted' }
    }
    return { success: false, error: result.error ?? 'Delete failed' }
  }

  const loadDeletePreview = async () => {
    const r = await deleteTaxReturnPreview(tr.id)
    if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
    return r.preview
  }

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' } : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-60 bg-white border rounded-lg shadow-lg overflow-hidden max-h-[70vh] overflow-y-auto"
          role="menu"
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 bg-zinc-50 border-b sticky top-0">
            Set status
          </div>
          {TAX_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSetStatus(s)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
            >
              <Circle className={`h-2.5 w-2.5 shrink-0 ${STATUS_DOT[s] ?? 'text-zinc-300'} fill-current`} />
              <span className="flex-1 truncate">{s}</span>
              {s === tr.status && <span className="text-[10px] text-zinc-400 shrink-0">current</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setDeleteOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-700 hover:bg-red-50 text-left border-t"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
        disabled={isPending}
        className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
        title="More actions"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
      </button>
      {menuPortal}

      <ConfirmDestructiveDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Tax Return"
        description={`Delete this tax return for ${tr.company_name ?? 'this client'}?`}
        severity="red"
        loadPreview={loadDeletePreview}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
      />
    </>
  )
}
