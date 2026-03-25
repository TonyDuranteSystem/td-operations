'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

interface ConvertLeadDialogProps {
  open: boolean
  onClose: () => void
  leadId: string
  leadName: string
}

export function ConvertLeadDialog({ open, onClose, leadId, leadName }: ConvertLeadDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [reason, setReason] = useState('')

  if (!open) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!reason.trim()) {
      toast.error('Reason is required')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/convert-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: leadId,
            reason: reason.trim(),
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to convert lead')
          return
        }

        toast.success(`${leadName} converted to contact`)
        setReason('')
        onClose()
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-md"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Convert to Contact
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            <p className="text-sm text-zinc-600">
              Convert <span className="font-semibold">{leadName}</span> to a Contact without requiring payment.
              This creates a contact record and marks the lead as converted.
            </p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              No payment will be recorded. No service deliveries will be created.
              Use &quot;Confirm Payment&quot; instead if the client has paid.
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Reason *</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Why is this lead being converted without payment?"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

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
                disabled={isPending || !reason.trim()}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Convert
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
