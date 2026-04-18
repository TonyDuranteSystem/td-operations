'use client'

/**
 * P3.9 — row-level action menu for payment rows on the account detail
 * Payments tab (and reusable anywhere a payments row renders).
 *
 * Closes the "read-only row" gap Antonio flagged on 2026-04-18:
 *   > "I can't manage that invoice, I can't do anything. If I ask Claude
 *    to open that invoice or see the situation, it can."
 *
 * Actions (visibility gated by row state):
 *   • Mark paid    — any non-paid row
 *   • Send reminder — invoiced, not paid / cancelled
 *   • Void         — invoiced, not paid / cancelled (P3.7 preview dialog)
 *   • Edit         — any row (amount / due date / description / notes)
 *   • Delete       — any non-paid row (P3.7 preview dialog; paid rows blocked)
 */

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  MoreVertical,
  CheckCircle,
  Send,
  Ban,
  Pencil,
  Trash2,
  Loader2,
  X,
} from 'lucide-react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import {
  markInvoicePaid,
  sendInvoiceReminder,
  voidInvoice,
  voidInvoicePreview,
  deletePayment,
  deletePaymentPreview,
  updateInvoice,
} from '@/app/(dashboard)/finance/actions'

export interface PaymentRowLike {
  id: string
  invoice_number: string | null
  description: string | null
  amount: number | null
  total?: number | string | null
  amount_currency: string | null
  status: string | null
  invoice_status?: string | null
  due_date?: string | null
  notes?: string | null
  message?: string | null
}

interface Props {
  payment: PaymentRowLike
}

export function PaymentRowActions({ payment }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  // Close on outside click (clicks inside the menu itself do not count as outside).
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

  // Menu positioner: one function, used by useLayoutEffect (first paint) and
  // the scroll / resize listeners. Uses a conservative menuHeight estimate so
  // the flip decision is correct even before the portal is measured.
  const positionMenu = () => {
    if (!buttonRef.current) return
    const btn = buttonRef.current.getBoundingClientRect()
    const menuWidth = 208 // matches w-52
    const measured = menuRef.current?.offsetHeight ?? 0
    // Conservative: assume at least 200px so we flip above when the button is
    // near the bottom of the viewport, even on the first layout pass when the
    // portal has not yet been measured.
    const menuHeight = Math.max(measured, 200)
    const gap = 4
    const margin = 8

    let top = btn.bottom + gap
    let left = btn.right - menuWidth

    // Flip above the button when there is not enough room below.
    if (top + menuHeight + margin > window.innerHeight) {
      const flippedTop = btn.top - menuHeight - gap
      if (flippedTop >= margin) {
        top = flippedTop
      } else {
        // Rare: viewport too short for either placement — clamp to stay visible.
        top = Math.max(margin, window.innerHeight - menuHeight - margin)
      }
    }

    // Clamp horizontally to the viewport.
    if (left + menuWidth + margin > window.innerWidth) {
      left = window.innerWidth - menuWidth - margin
    }
    if (left < margin) left = margin

    setMenuPos({ top, left })
  }

  // First paint: position before the menu becomes visible.
  useLayoutEffect(() => {
    if (!menuOpen) return
    positionMenu()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- positionMenu reads refs, not deps
  }, [menuOpen])

  // Follow the row on scroll / resize while the menu is open.
  useEffect(() => {
    if (!menuOpen) return
    const handler = () => positionMenu()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- positionMenu is stable enough for this
  }, [menuOpen])

  const statusValue = (payment.invoice_status ?? payment.status ?? '').toString()
  const isPaid = statusValue === 'Paid'
  const isCancelled = statusValue === 'Cancelled' || statusValue === 'Waived' || statusValue === 'Voided'
  const isInvoiced = !!payment.invoice_number && payment.invoice_number !== '1.0' && payment.invoice_number !== '2.0'

  const label = isInvoiced ? `invoice ${payment.invoice_number}` : 'payment placeholder'

  const handleMarkPaid = () => {
    setMenuOpen(false)
    startTransition(async () => {
      const result = await markInvoicePaid(payment.id)
      if (result.success) {
        toast.success(`${label} marked as Paid`)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Failed to mark as paid')
      }
    })
  }

  const handleSendReminder = () => {
    setMenuOpen(false)
    startTransition(async () => {
      const result = await sendInvoiceReminder(payment.id)
      if (result.success) {
        toast.success(`Reminder sent for ${label}`)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Failed to send reminder')
      }
    })
  }

  const handleVoidConfirm = async () => {
    const result = await voidInvoice(payment.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: `${label} voided` }
    }
    return { success: false, error: result.error ?? 'Void failed' }
  }

  const loadVoidPreview = async () => {
    const r = await voidInvoicePreview(payment.id)
    if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
    return r.preview
  }

  const handleDeleteConfirm = async () => {
    const result = await deletePayment(payment.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: 'Deleted' }
    }
    return { success: false, error: result.error ?? 'Delete failed' }
  }

  const loadDeletePreview = async () => {
    const r = await deletePaymentPreview(payment.id)
    if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
    return r.preview
  }

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' } : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-52 bg-white border rounded-lg shadow-lg overflow-hidden"
          role="menu"
        >
          {!isPaid && !isCancelled && (
            <button
              type="button"
              onClick={handleMarkPaid}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 text-left"
            >
              <CheckCircle className="h-4 w-4" /> Mark as Paid
            </button>
          )}
          {isInvoiced && !isPaid && !isCancelled && (
            <button
              type="button"
              onClick={handleSendReminder}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 text-left"
            >
              <Send className="h-4 w-4" /> Send reminder
            </button>
          )}
          {isInvoiced && !isPaid && !isCancelled && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setVoidOpen(true) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 text-left"
            >
              <Ban className="h-4 w-4" /> Void
            </button>
          )}
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setEditOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left border-t"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setDeleteOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-700 hover:bg-red-50 text-left"
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
        title="Row actions"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
      </button>
      {menuPortal}

      <ConfirmDestructiveDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Void Invoice"
        description={`Void ${label}?`}
        severity="red"
        loadPreview={loadVoidPreview}
        confirmLabel="Void"
        onConfirm={handleVoidConfirm}
      />

      <ConfirmDestructiveDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Payment"
        description={`Delete ${label}? This removes the row from the ledger.`}
        severity="red"
        loadPreview={loadDeletePreview}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
      />

      {editOpen && (
        <EditPaymentDialog
          payment={payment}
          onClose={() => setEditOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  )
}

// ── Edit Payment Dialog ────────────────────────────────────────

function EditPaymentDialog({
  payment,
  onClose,
  onSaved,
}: {
  payment: PaymentRowLike
  onClose: () => void
  onSaved: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [total, setTotal] = useState(String(payment.total ?? payment.amount ?? 0))
  const [dueDate, setDueDate] = useState(payment.due_date ?? '')
  const [description, setDescription] = useState(payment.description ?? '')
  const [notes, setNotes] = useState(payment.notes ?? '')
  const [message, setMessage] = useState(payment.message ?? '')

  const handleSave = () => {
    startTransition(async () => {
      const updates: { total?: number; due_date?: string; notes?: string; message?: string; description?: string } = {}
      const newTotal = parseFloat(total)
      if (!isNaN(newTotal) && newTotal !== Number(payment.total ?? payment.amount ?? 0)) updates.total = newTotal
      if (dueDate !== (payment.due_date ?? '')) updates.due_date = dueDate
      if (description !== (payment.description ?? '')) updates.description = description
      if (notes !== (payment.notes ?? '')) updates.notes = notes
      if (message !== (payment.message ?? '')) updates.message = message

      if (Object.keys(updates).length === 0) {
        onClose()
        return
      }

      const result = await updateInvoice(payment.id, updates)
      if (result.success) {
        toast.success('Saved')
        onSaved()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to save')
      }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">
            Edit {payment.invoice_number ? `invoice ${payment.invoice_number}` : 'payment'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Amount ({payment.amount_currency || 'USD'})
              </label>
              <input
                type="number"
                step="0.01"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Due date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Payment terms <span className="text-amber-600">(visible to client in portal)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="e.g. Net 30, Due upon receipt"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Internal notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Notes for staff only"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
