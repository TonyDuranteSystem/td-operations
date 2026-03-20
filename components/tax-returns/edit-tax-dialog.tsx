'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TAX_RETURN_STATUS } from '@/lib/constants'
import { updateTaxReturn } from '@/app/(dashboard)/tax-returns/actions'
import type { TaxReturn } from '@/lib/types'

interface EditTaxDialogProps {
  open: boolean
  onClose: () => void
  taxReturn: TaxReturn
}

export function EditTaxDialog({ open, onClose, taxReturn }: EditTaxDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState(taxReturn.status)
  const [paid, setPaid] = useState(taxReturn.paid ?? false)
  const [dataReceived, setDataReceived] = useState(taxReturn.data_received ?? false)
  const [sentToIndia, setSentToIndia] = useState(taxReturn.sent_to_india ?? false)
  const [extensionFiled, setExtensionFiled] = useState(taxReturn.extension_filed ?? false)
  const [extensionDeadline, setExtensionDeadline] = useState(taxReturn.extension_deadline ?? '')
  const [deadline, setDeadline] = useState(taxReturn.deadline ?? '')
  const [notes, setNotes] = useState(taxReturn.notes ?? '')

  if (!open) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    startTransition(async () => {
      const updates: Record<string, unknown> = {
        status,
        paid,
        data_received: dataReceived,
        sent_to_india: sentToIndia,
        extension_filed: extensionFiled,
        extension_deadline: extensionFiled ? (extensionDeadline || null) : null,
        deadline: deadline || null,
        notes: notes.trim() || null,
      }

      const result = await updateTaxReturn(taxReturn.id, updates, taxReturn.updated_at)

      if (result.success) {
        toast.success('Tax return aggiornato')
        onClose()
      } else {
        toast.error(result.error ?? 'Errore aggiornamento')
      }
    })
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div>
              <h2 className="text-lg font-semibold">{taxReturn.company_name}</h2>
              <p className="text-sm text-muted-foreground">
                {taxReturn.return_type} — Tax Year {taxReturn.tax_year}
              </p>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Status */}
            <div>
              <label className="block text-sm font-medium mb-1">Status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {TAX_RETURN_STATUS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            {/* Boolean toggles */}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={paid}
                  onChange={e => setPaid(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Paid
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dataReceived}
                  onChange={e => setDataReceived(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Data Received
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sentToIndia}
                  onChange={e => setSentToIndia(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Sent to India
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={extensionFiled}
                  onChange={e => setExtensionFiled(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Extension Filed
              </label>
            </div>

            {/* Extension Deadline (shown when extension_filed) */}
            {extensionFiled && (
              <div>
                <label className="block text-sm font-medium mb-1">Extension Deadline</label>
                <input
                  type="date"
                  value={extensionDeadline}
                  onChange={e => setExtensionDeadline(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Deadline */}
            <div>
              <label className="block text-sm font-medium mb-1">Deadline</label>
              <input
                type="date"
                value={deadline}
                onChange={e => setDeadline(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={4}
                placeholder="Notes..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
