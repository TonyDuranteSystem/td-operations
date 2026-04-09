'use client'

import { useState, useEffect } from 'react'
import { X, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { ACCOUNT_STATUS } from '@/lib/constants'
import {
  getCascadesForStatus,
  getDefaultSelections,
} from '@/lib/account-status-cascades'
import {
  changeAccountStatus,
  previewStatusChange,
  type StatusChangeOptions,
  type StatusChangePreview,
} from '@/app/(dashboard)/accounts/actions'

interface Props {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
  currentStatus: string
  updatedAt: string
}

export function StatusChangeDialog({
  open,
  onClose,
  accountId,
  companyName,
  currentStatus,
  updatedAt,
}: Props) {
  const [newStatus, setNewStatus] = useState<string>(currentStatus)
  const [note, setNote] = useState('')
  const [selections, setSelections] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<StatusChangePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Reset form when opened
  useEffect(() => {
    if (open) {
      setNewStatus(currentStatus)
      setNote('')
      setPreview(null)
      setSelections({})
    }
  }, [open, currentStatus])

  // When target status changes to one with cascades, load preview counts + reset selections
  useEffect(() => {
    if (!open) return
    const actions = getCascadesForStatus(newStatus)
    if (actions.length === 0) {
      setPreview(null)
      setSelections({})
      return
    }
    setSelections(getDefaultSelections(newStatus))
    // Load preview counts
    setLoadingPreview(true)
    previewStatusChange(accountId, newStatus)
      .then((res) => {
        if (res.success && res.preview) setPreview(res.preview)
        else setPreview(null)
      })
      .finally(() => setLoadingPreview(false))
  }, [open, newStatus, accountId])

  if (!open) return null

  const actions = getCascadesForStatus(newStatus)
  const isCascading = actions.length > 0
  const noChange = newStatus === currentStatus

  const toggle = (key: string) => {
    setSelections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleConfirm = async () => {
    if (noChange) {
      toast.error('Status unchanged')
      return
    }
    setSubmitting(true)
    const options = selections as StatusChangeOptions
    const result = await changeAccountStatus(accountId, newStatus, options, note, updatedAt)
    setSubmitting(false)
    if (result.success) {
      const cascadeCount = result.cascadesApplied?.length ?? 0
      toast.success(
        cascadeCount > 0
          ? `Status set to ${newStatus} — ${cascadeCount} side effect(s) applied`
          : `Status set to ${newStatus}`,
      )
      onClose()
    } else {
      toast.error(result.error ?? 'Failed to change status')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Change Account Status</h2>
            <p className="text-sm text-zinc-500">{companyName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-zinc-100"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-zinc-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Current status */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500">Current:</span>
            <span className="font-medium">{currentStatus || '(unset)'}</span>
          </div>

          {/* New status select */}
          <div>
            <label htmlFor="status-select" className="block text-sm font-medium mb-1.5">
              New status
            </label>
            <select
              id="status-select"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              {ACCOUNT_STATUS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Preview counts */}
          {isCascading && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800 flex-1">
                  {loadingPreview && (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Calculating impact...
                    </span>
                  )}
                  {!loadingPreview && preview && (
                    <div className="space-y-0.5">
                      <div className="font-medium">This change will affect:</div>
                      <ul className="list-disc list-inside space-y-0.5">
                        <li>{preview.activeDeliveries} active service deliveries</li>
                        <li>{preview.pendingDeadlines} pending deadlines</li>
                        <li>{preview.openTasks} open tasks</li>
                        <li>{preview.pendingPayments} pending/overdue payments</li>
                      </ul>
                    </div>
                  )}
                  {!loadingPreview && !preview && (
                    <span>Impact preview unavailable (change will still apply).</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Cascades checkboxes */}
          {isCascading && (
            <div>
              <div className="text-sm font-medium mb-2">Side effects</div>
              <div className="space-y-2">
                {actions.map((a) => (
                  <label
                    key={a.key}
                    className="flex items-start gap-3 p-2.5 rounded-lg border border-zinc-200 hover:bg-zinc-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={!!selections[a.key]}
                      onChange={() => toggle(a.key)}
                      className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-amber-600 focus:ring-amber-500"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{a.label}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">{a.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Note */}
          <div>
            <label htmlFor="status-note" className="block text-sm font-medium mb-1.5">
              Note (optional)
            </label>
            <textarea
              id="status-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is the status changing? This will be appended to the account notes."
              rows={2}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t px-6 py-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || noChange}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Applying...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Confirm status change
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
