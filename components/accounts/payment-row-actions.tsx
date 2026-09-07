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
  Undo2,
  X,
} from 'lucide-react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  markInvoicePaid,
  sendInvoiceReminder,
  voidInvoice,
  voidInvoicePreview,
  reactivateInvoice,
  reactivateInvoicePreview,
  deletePayment,
  deletePaymentPreview,
  updateInvoice,
} from '@/app/(dashboard)/finance/actions'
import { createInvoice } from '@/app/(dashboard)/shared/invoice-actions'
import { PaidInvoiceCorrectionPrompt, type CorrectionPath } from '@/components/shared/paid-invoice-correction-prompt'

export interface PaymentRowLike {
  id: string
  invoice_number: string | null
  description: string | null
  amount: number | null
  total?: number | string | null
  amount_paid?: number | string | null
  amount_currency: string | null
  status: string | null
  invoice_status?: string | null
  due_date?: string | null
  notes?: string | null
  message?: string | null
  account_id?: string | null
  contact_id?: string | null
}

interface Props {
  payment: PaymentRowLike
  /** Account-level reminder pause (boolean or active dated pause) — when set,
   *  Send Reminder warns and requires an explicit "send anyway" (force). */
  reminderPaused?: { active: boolean; until: string | null } | null
}

export function PaymentRowActions({ payment, reminderPaused }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [reactivateOpen, setReactivateOpen] = useState(false)
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
  // Fixed 2026-09-07 (full council review, blocker #1): a genuinely Partial
  // row (real money already on file) isn't "Paid" by this check, so it was
  // still eligible for the blunt Mark-as-Paid action below — which
  // overwrites whatever's recorded with the full total, fabricating the
  // difference. Hide the action wherever there's already real money on it;
  // Edit is the safe path to reconcile a Partial invoice's balance.
  const hasRealPartialPayment = Number(payment.amount_paid ?? 0) > 0
  // Only a true Cancelled invoice can be brought back. Waived/Voided are
  // different lifecycle ends and have no reactivate path.
  const canReactivate = statusValue === 'Cancelled'
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
    // Paused client → explicit warn-and-confirm, then a deliberate force-send.
    const paused = reminderPaused?.active === true
    if (paused) {
      const until = reminderPaused?.until
      if (!window.confirm(
        `⏸ Payment reminders are PAUSED for this client${until ? ` until ${until}` : ''}${payment.notes?.trim() ? `\n\nInternal note: ${payment.notes.trim()}` : ''}\n\nSend the reminder for ${label} anyway?`,
      )) return
    }
    startTransition(async () => {
      const result = await sendInvoiceReminder(payment.id, { force: paused })
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

  const handleReactivateConfirm = async () => {
    const result = await reactivateInvoice(payment.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: `${label} reactivated as ${result.data?.invoice_status ?? 'open'}` }
    }
    return { success: false, error: result.error ?? 'Reactivate failed' }
  }

  const loadReactivatePreview = async () => {
    const r = await reactivateInvoicePreview(payment.id)
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
          {!isPaid && !isCancelled && !hasRealPartialPayment && (
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
          {isInvoiced && canReactivate && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setReactivateOpen(true) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 text-left"
            >
              <Undo2 className="h-4 w-4" /> Reactivate
            </button>
          )}
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setEditOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
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
      <FastTooltip label="Row actions">
        <button
          ref={buttonRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
          disabled={isPending}
          className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
          aria-label="Row actions"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
        </button>
      </FastTooltip>
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
        open={reactivateOpen}
        onClose={() => setReactivateOpen(false)}
        title="Reactivate Invoice"
        description={`Bring ${label} back as a live invoice?`}
        severity="amber"
        loadPreview={loadReactivatePreview}
        confirmLabel="Reactivate"
        onConfirm={handleReactivateConfirm}
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
  // Set only when Save hits an already-Paid invoice with a changed amount —
  // holds the non-total edits so they aren't lost while the correction
  // prompt is up (dev job ef5da377).
  const [pendingNonTotalUpdates, setPendingNonTotalUpdates] = useState<Record<string, unknown> | null>(null)

  // Fixed 2026-09-07 (full council review, blocker #3): this used to also
  // trigger on the coarse `status` field, which disagrees with
  // `invoice_status` on real rows today — a credit note (status is ALWAYS
  // 'Paid' at creation) and 46 real legacy/bare payments in production both
  // read status='Paid' with a different invoice_status. Those rows showed
  // this correction prompt and promised an outcome (reopen as Partial, etc.)
  // that the server — which gates on invoice_status alone — silently never
  // delivered, whichever option staff picked. invoice_status is the single
  // source of truth for "is this actually a settled invoice", matching the
  // server's own check two lines below in updateInvoice.
  const isPaid = payment.invoice_status === 'Paid'

  const applyUpdate = (
    updates: { total?: number; due_date?: string; notes?: string; message?: string; description?: string },
    correctionPath?: 'partial_payment' | 'typo'
  ) => {
    startTransition(async () => {
      const result = await updateInvoice(payment.id, updates, correctionPath)
      if (result.success) {
        toast.success('Saved')
        onSaved()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to save')
      }
    })
  }

  const handleSave = () => {
    const updates: { total?: number; due_date?: string; notes?: string; message?: string; description?: string } = {}
    const newTotal = parseFloat(total)
    const totalChanged = !isNaN(newTotal) && newTotal !== Number(payment.total ?? payment.amount ?? 0)
    if (totalChanged) updates.total = newTotal
    if (dueDate !== (payment.due_date ?? '')) updates.due_date = dueDate
    if (description !== (payment.description ?? '')) updates.description = description
    if (notes !== (payment.notes ?? '')) updates.notes = notes
    if (message !== (payment.message ?? '')) updates.message = message

    if (Object.keys(updates).length === 0) {
      onClose()
      return
    }

    if (totalChanged && isPaid) {
      const { total: _t, ...rest } = updates
      setPendingNonTotalUpdates(rest)
      return
    }

    applyUpdate(updates)
  }

  const handleCorrectionChoice = (path: CorrectionPath) => {
    const newTotal = parseFloat(total)
    const oldTotal = Number(payment.total ?? payment.amount ?? 0)
    const nonTotal = pendingNonTotalUpdates ?? {}

    if (path === 'new_charge') {
      if (newTotal - oldTotal <= 0) {
        toast.error("A new charge needs a higher amount than before — that's what becomes the new invoice.")
        return
      }
      // Checked before anything is saved (fixed 2026-09-07, second bug-hunter
      // pass): this used to run after the non-total fields were already
      // saved, so a contact-only invoice with no linked account silently
      // half-applied the edit while showing only an error toast.
      if (!payment.account_id) {
        toast.error('This invoice has no linked account — create the new invoice manually instead.')
        return
      }
      startTransition(async () => {
        if (Object.keys(nonTotal).length > 0) {
          const r = await updateInvoice(payment.id, nonTotal)
          if (!r.success) { toast.error(r.error ?? 'Failed to save the other changes'); return }
        }
        const difference = newTotal - oldTotal
        const today = new Date().toISOString().split('T')[0]
        const label = `Additional charge — ${payment.invoice_number ?? ''}`.trim()
        const created = await createInvoice({
          account_id: payment.account_id,
          description: label,
          amount_currency: (payment.amount_currency as 'USD' | 'EUR') || 'USD',
          issue_date: today,
          discount: 0,
          items: [{ description: label, quantity: 1, unit_price: difference, amount: difference, sort_order: 0 }],
        })
        if (created.success) {
          toast.success(`${payment.invoice_number ?? 'Invoice'} left unchanged — created ${created.data?.invoice_number} (Draft) for the difference`)
          onSaved()
          onClose()
        } else {
          toast.error(created.error ?? 'Failed to create the new invoice')
        }
      })
      return
    }

    applyUpdate({ ...nonTotal, total: newTotal }, path)
  }

  if (pendingNonTotalUpdates !== null) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
          <PaidInvoiceCorrectionPrompt
            invoiceLabel={payment.invoice_number ?? 'This invoice'}
            currency={payment.amount_currency || 'USD'}
            oldTotal={Number(payment.total ?? payment.amount ?? 0)}
            newTotal={parseFloat(total) || 0}
            currentAmountPaid={Number(payment.amount_paid ?? 0)}
            isPending={isPending}
            onCancel={() => setPendingNonTotalUpdates(null)}
            onChoose={handleCorrectionChoice}
          />
        </div>
      </div>
    )
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

