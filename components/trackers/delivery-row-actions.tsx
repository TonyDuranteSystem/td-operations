'use client'

/**
 * P3.9 Priority 1 — row-level action menu for service delivery cards.
 *
 * Used on the trackers/[serviceType] kanban (TrackerCard) and the
 * contact detail Services tab. Actions:
 *   • Edit notes (inline dialog)
 *   • Reassign to (submenu — Luca / Antonio / Other)
 *   • Mark complete (only when not already completed/cancelled)
 *   • Cancel (soft stop — auto-closes linked tasks)
 *   • Delete (hard remove — blocked on completed)
 *
 * Same portal + flip-above + viewport-clamp pattern as PaymentRowActions
 * and the other P3.9 menus.
 */

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  MoreVertical,
  Loader2,
  Trash2,
  StickyNote,
  CheckCircle,
  Ban,
  UserCheck,
  X,
} from 'lucide-react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import {
  updateDeliveryNotes,
  reassignDelivery,
  completeDelivery,
  cancelDelivery,
  deleteDelivery,
  deliveryDeletePreview,
} from '@/app/(dashboard)/trackers/[serviceType]/actions'

export interface DeliveryRowData {
  id: string
  service_name: string | null
  service_type: string | null
  status: string | null
  stage: string | null
  assigned_to: string | null
  notes: string | null
  updated_at: string
}

interface Props {
  delivery: DeliveryRowData
}

export function DeliveryRowActions({ delivery }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  const isCompleted = delivery.status === 'completed'
  const isCancelled = delivery.status === 'cancelled'

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
    const menuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, 240)
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

  const handleReassign = (assignee: string) => {
    if (assignee === delivery.assigned_to) { setMenuOpen(false); return }
    setMenuOpen(false)
    startTransition(async () => {
      const result = await reassignDelivery(delivery.id, assignee, delivery.updated_at)
      if (result.success) {
        toast.success(`Assigned \u2192 ${assignee}`)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Failed to reassign')
      }
    })
  }

  const handleComplete = () => {
    setMenuOpen(false)
    startTransition(async () => {
      const result = await completeDelivery(delivery.id)
      if (result.success) {
        toast.success('Service completed')
        router.refresh()
      } else {
        toast.error(result.error ?? 'Failed to complete')
      }
    })
  }

  const handleCancelConfirm = async () => {
    const result = await cancelDelivery(delivery.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: 'Service cancelled' }
    }
    return { success: false, error: result.error ?? 'Cancel failed' }
  }

  const handleDeleteConfirm = async () => {
    const result = await deleteDelivery(delivery.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: 'Service deleted' }
    }
    return { success: false, error: result.error ?? 'Delete failed' }
  }

  const loadDeletePreview = async () => {
    const r = await deliveryDeletePreview(delivery.id)
    if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
    return r.preview
  }

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' } : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-[220px] bg-white border rounded-lg shadow-lg overflow-hidden"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setNotesOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
          >
            <StickyNote className="h-4 w-4" /> Edit notes
          </button>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setReassignOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left border-t"
          >
            <UserCheck className="h-4 w-4" /> Reassign
            {delivery.assigned_to && (
              <span className="ml-auto text-[10px] text-zinc-400">{delivery.assigned_to}</span>
            )}
          </button>
          {!isCompleted && !isCancelled && (
            <button
              type="button"
              onClick={handleComplete}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 text-left border-t"
            >
              <CheckCircle className="h-4 w-4" /> Mark complete
            </button>
          )}
          {!isCompleted && !isCancelled && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setCancelOpen(true) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 text-left border-t"
            >
              <Ban className="h-4 w-4" /> Cancel
            </button>
          )}
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
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o) }}
        disabled={isPending}
        className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
        title="More actions"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
      </button>
      {menuPortal}

      <ConfirmDestructiveDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel Service"
        description={`Cancel "${delivery.service_name ?? delivery.service_type ?? 'this service'}"?`}
        severity="amber"
        staticPreview={{
          affected: { service_delivery: 1 },
          items: [
            {
              label: delivery.service_name ?? delivery.service_type ?? 'Service',
              details: [
                delivery.stage ?? '',
                delivery.status ?? '',
                delivery.assigned_to ? `assigned ${delivery.assigned_to}` : '',
              ].filter(Boolean) as string[],
            },
          ],
          warnings: [
            'Status is set to cancelled with today as end date.',
            'All linked open tasks (To Do / In Progress / Waiting) are auto-closed.',
            'Does NOT refund payment — issue a credit note if needed.',
          ],
        }}
        confirmLabel="Cancel Service"
        onConfirm={handleCancelConfirm}
      />

      <ConfirmDestructiveDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Service Delivery"
        description={`Delete "${delivery.service_name ?? delivery.service_type ?? 'this service'}"?`}
        severity="red"
        loadPreview={loadDeletePreview}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
      />

      {notesOpen && (
        <EditNotesDialog
          deliveryId={delivery.id}
          initialNotes={delivery.notes ?? ''}
          updatedAt={delivery.updated_at}
          onClose={() => setNotesOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}

      {reassignOpen && (
        <ReassignDialog
          current={delivery.assigned_to ?? ''}
          onClose={() => setReassignOpen(false)}
          onPick={(name) => {
            setReassignOpen(false)
            handleReassign(name)
          }}
        />
      )}
    </>
  )
}

// ── Edit notes dialog ────────────────────────────────────

function EditNotesDialog({
  deliveryId,
  initialNotes,
  updatedAt,
  onClose,
  onSaved,
}: {
  deliveryId: string
  initialNotes: string
  updatedAt: string
  onClose: () => void
  onSaved: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [notes, setNotes] = useState(initialNotes)

  const handleSave = () => {
    startTransition(async () => {
      const result = await updateDeliveryNotes(deliveryId, notes, updatedAt)
      if (result.success) {
        toast.success('Notes saved')
        onSaved()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to save notes')
      }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold">Edit notes</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoFocus
            rows={6}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            placeholder="Service delivery notes (internal)."
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
            disabled={isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reassign dialog ──────────────────────────────────────

function ReassignDialog({
  current,
  onClose,
  onPick,
}: {
  current: string
  onClose: () => void
  onPick: (name: string) => void
}) {
  const [custom, setCustom] = useState('')
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold">Reassign service</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-2">
          {['Luca', 'Antonio'].map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onPick(name)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm border rounded-md hover:bg-zinc-50"
            >
              <span>{name}</span>
              {name === current && <span className="text-[10px] text-zinc-400">current</span>}
            </button>
          ))}
          <div className="pt-2 border-t space-y-2">
            <p className="text-xs text-zinc-500">Or assign to someone else:</p>
            <div className="flex gap-2">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="flex-1 px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Name"
              />
              <button
                type="button"
                onClick={() => custom.trim() && onPick(custom.trim())}
                disabled={!custom.trim()}
                className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
