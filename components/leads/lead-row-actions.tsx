'use client'

/**
 * P3.9 — row-level action menu for lead list rows on /leads.
 *
 * The leads table renders each row as a navigation link. Clicking the
 * row opens the lead detail page. This menu lives inside the row but
 * stops propagation so the link doesn't fire when the operator just
 * wants to change status, mark lost, or delete.
 *
 * Same portal + flip-above pattern as PaymentRowActions / TaskRowActions /
 * TaxRowActions.
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
  XCircle,
  X,
} from 'lucide-react'
import { DeleteLeadDialog } from '@/app/(dashboard)/leads/[id]/components/delete-lead-dialog'

const LEAD_STATUSES = [
  'New',
  'Call Scheduled',
  'Call Done',
  'Contacted',
  'Qualified',
  'Offer Sent',
  'Negotiating',
  'Suspended',
] as const

const STATUS_DOT: Record<string, string> = {
  New: 'text-blue-500',
  'Call Scheduled': 'text-violet-500',
  'Call Done': 'text-indigo-500',
  Contacted: 'text-amber-500',
  Qualified: 'text-teal-500',
  'Offer Sent': 'text-orange-500',
  Negotiating: 'text-yellow-500',
  Suspended: 'text-zinc-400',
}

export interface LeadRowData {
  id: string
  full_name: string
  status: string | null
}

interface Props {
  lead: LeadRowData
}

export function LeadRowActions({ lead }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [markLostOpen, setMarkLostOpen] = useState(false)
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
    const menuWidth = 220
    const menuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, 360)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler stable enough
  }, [menuOpen])

  const handleSetStatus = (status: string) => {
    if (status === lead.status) { setMenuOpen(false); return }
    setMenuOpen(false)
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/update-lead-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: lead.id, status }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error ?? 'Failed to update status')
          return
        }
        toast.success(`Status \u2192 ${status}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      }
    })
  }

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' } : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-[220px] bg-white border rounded-lg shadow-lg overflow-hidden max-h-[70vh] overflow-y-auto"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 bg-zinc-50 border-b sticky top-0">
            Set status
          </div>
          {LEAD_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSetStatus(s)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
            >
              <Circle className={`h-2.5 w-2.5 shrink-0 ${STATUS_DOT[s] ?? 'text-zinc-300'} fill-current`} />
              <span className="flex-1 truncate">{s}</span>
              {s === lead.status && <span className="text-[10px] text-zinc-400 shrink-0">current</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setMarkLostOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left border-t"
          >
            <XCircle className="h-4 w-4 text-zinc-500" /> Mark as Lost
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDeleteOpen(true) }}
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
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o) }}
        disabled={isPending}
        className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
        title="More actions"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
      </button>
      {menuPortal}

      <DeleteLeadDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        leadId={lead.id}
        leadName={lead.full_name}
      />

      {markLostOpen && (
        <MarkLostDialog
          leadId={lead.id}
          leadName={lead.full_name}
          onClose={() => setMarkLostOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  )
}

function MarkLostDialog({
  leadId,
  leadName,
  onClose,
  onSaved,
}: {
  leadId: string
  leadName: string
  onClose: () => void
  onSaved: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [reason, setReason] = useState('')

  const handleSave = () => {
    const trimmed = reason.trim()
    if (!trimmed) {
      toast.error('Reason is required')
      return
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/mark-lost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId, reason: trimmed }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error ?? 'Failed to mark lost')
          return
        }
        toast.success(data.message ?? `${leadName} marked as Lost`)
        onSaved()
        onClose()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      }
    })
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold truncate">Mark {leadName} as Lost</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-zinc-500">
            The reason is appended to the lead notes for audit trail. Status is set to Lost.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
            rows={4}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 resize-none"
            placeholder="e.g. Went with competitor, budget constraints, timing mismatch..."
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-3 py-1.5 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || !reason.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Mark as Lost
          </button>
        </div>
      </div>
    </div>
  )
}
