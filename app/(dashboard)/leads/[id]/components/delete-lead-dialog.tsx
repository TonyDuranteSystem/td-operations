'use client'

import { useState, useEffect, useTransition } from 'react'
import { X, Loader2, Trash2, AlertTriangle, RotateCcw, UserX } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

// ---------- Types ----------

interface DeletePreview {
  lead: { id: string; full_name: string; email: string | null; status: string }
  offers: Array<{ token: string; status: string }>
  contracts: Array<{ id: string; signed_at: string | null; offer_token: string }>
  activations: Array<{ id: string; status: string }>
  portal_user: { id: string; email: string } | null
  summary: {
    offers: number
    contracts: number
    activations: number
    has_portal_user: boolean
  }
}

// ---------- Delete Lead Dialog ----------

interface DeleteLeadDialogProps {
  open: boolean
  onClose: () => void
  leadId: string
  leadName: string
}

export function DeleteLeadDialog({ open, onClose, leadId, leadName }: DeleteLeadDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Fetch preview when dialog opens
  useEffect(() => {
    if (!open) {
      setPreview(null)
      setConfirmText('')
      setError(null)
      return
    }

    setLoading(true)
    fetch('/api/crm/admin-actions/lead-delete-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setPreview(data as DeletePreview)
        } else {
          setError(data.error || 'Failed to load preview')
        }
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, leadId])

  if (!open) return null

  const canConfirm = confirmText.toLowerCase() === leadName.toLowerCase()

  const handleDelete = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/delete-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to delete lead')
          return
        }

        toast.success(data.message || `${leadName} deleted`)
        onClose()
        router.push('/leads')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  const totalItems = preview
    ? preview.summary.offers + preview.summary.contracts + preview.summary.activations + (preview.summary.has_portal_user ? 1 : 0)
    : 0

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold flex items-center gap-2 text-red-700">
              <Trash2 className="h-5 w-5" />
              Delete Lead
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4">
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                <span className="ml-2 text-sm text-zinc-500">Loading related data...</span>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {preview && (
              <>
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                    <div className="text-sm text-red-800">
                      <p className="font-semibold">
                        Permanently delete {leadName} and all related data?
                      </p>
                      <p className="mt-1 text-red-700">This action cannot be undone.</p>
                    </div>
                  </div>
                </div>

                {/* What will be deleted */}
                <div className="border rounded-lg divide-y">
                  <div className="px-4 py-2.5 bg-zinc-50 text-xs font-semibold text-zinc-600 uppercase tracking-wide">
                    Will be deleted ({totalItems + 1} items)
                  </div>

                  {/* Lead */}
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span className="text-sm">Lead: <span className="font-medium">{preview.lead.full_name}</span></span>
                    <span className="text-xs text-zinc-500">{preview.lead.email ?? 'no email'}</span>
                  </div>

                  {/* Offers */}
                  {preview.summary.offers > 0 && (
                    <div className="px-4 py-2.5">
                      <span className="text-sm">
                        {preview.summary.offers} offer{preview.summary.offers !== 1 ? 's' : ''}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {preview.offers.map(o => (
                          <span key={o.token} className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
                            {o.token} ({o.status})
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Contracts */}
                  {preview.summary.contracts > 0 && (
                    <div className="px-4 py-2.5">
                      <span className="text-sm">
                        {preview.summary.contracts} contract{preview.summary.contracts !== 1 ? 's' : ''}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {preview.contracts.map(c => (
                          <span key={c.id} className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
                            {c.signed_at ? `signed ${c.signed_at.split('T')[0]}` : 'unsigned'}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Activations */}
                  {preview.summary.activations > 0 && (
                    <div className="px-4 py-2.5">
                      <span className="text-sm">
                        {preview.summary.activations} pending activation{preview.summary.activations !== 1 ? 's' : ''}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {preview.activations.map(a => (
                          <span key={a.id} className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
                            {a.status}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Portal user */}
                  {preview.portal_user && (
                    <div className="px-4 py-2.5 flex items-center justify-between">
                      <span className="text-sm">Portal user</span>
                      <span className="text-xs text-zinc-500">{preview.portal_user.email}</span>
                    </div>
                  )}

                  {/* Nothing extra */}
                  {totalItems === 0 && (
                    <div className="px-4 py-2.5 text-sm text-zinc-500">
                      No related offers, contracts, or portal user found.
                    </div>
                  )}
                </div>

                {/* Type to confirm */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Type <span className="font-semibold text-red-700">{leadName}</span> to confirm
                  </label>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    autoFocus
                    placeholder={leadName}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
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
                    onClick={handleDelete}
                    disabled={isPending || !canConfirm}
                    className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Delete Everything
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- Delete Offer Dialog ----------

interface DeleteOfferDialogProps {
  open: boolean
  onClose: () => void
  offerToken: string
  leadName: string
}

export function DeleteOfferDialog({ open, onClose, offerToken, leadName }: DeleteOfferDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!open) return null

  const handleDelete = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/delete-offer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer_token: offerToken }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to delete offer')
          return
        }

        toast.success(data.message || 'Offer deleted')
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
            <h2 className="text-lg font-semibold flex items-center gap-2 text-red-700">
              <Trash2 className="h-5 w-5" />
              Delete Offer
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4">
            <p className="text-sm text-zinc-600">
              Delete offer <span className="font-semibold text-zinc-900">{offerToken}</span> for{' '}
              <span className="font-semibold">{leadName}</span>?
            </p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              This will also delete all contracts and pending activations linked to this offer.
              The lead record will be kept so you can create a new offer.
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
                onClick={handleDelete}
                disabled={isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete Offer
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- Reset Offer Dialog ----------

interface ResetOfferDialogProps {
  open: boolean
  onClose: () => void
  offerToken: string
  leadName: string
}

export function ResetOfferDialog({ open, onClose, offerToken, leadName }: ResetOfferDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!open) return null

  const handleReset = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/reset-offer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer_token: offerToken }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to reset offer')
          return
        }

        toast.success(data.message || 'Offer reset to draft')
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
            <h2 className="text-lg font-semibold flex items-center gap-2 text-amber-700">
              <RotateCcw className="h-5 w-5" />
              Reset Offer
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4">
            <p className="text-sm text-zinc-600">
              Reset offer <span className="font-semibold text-zinc-900">{offerToken}</span> for{' '}
              <span className="font-semibold">{leadName}</span> to draft?
            </p>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
              <ul className="list-disc list-inside space-y-1">
                <li>Offer status will be set back to <strong>draft</strong></li>
                <li>Payment links will be cleared</li>
                <li>All contracts and pending activations will be deleted</li>
                <li>Client can re-sign the offer fresh</li>
              </ul>
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
                onClick={handleReset}
                disabled={isPending}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Reset to Draft
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- Delete Portal User Dialog ----------

interface DeletePortalUserDialogProps {
  open: boolean
  onClose: () => void
  email: string
  leadName: string
}

export function DeletePortalUserDialog({ open, onClose, email, leadName }: DeletePortalUserDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!open) return null

  const handleDelete = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/delete-portal-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to delete portal user')
          return
        }

        toast.success(data.message || 'Portal user deleted')
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
            <h2 className="text-lg font-semibold flex items-center gap-2 text-red-700">
              <UserX className="h-5 w-5" />
              Delete Portal User
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4">
            <p className="text-sm text-zinc-600">
              Delete the portal login for <span className="font-semibold">{leadName}</span>?
            </p>

            <div className="bg-zinc-50 border rounded-lg p-3 text-sm">
              <span className="text-zinc-500">Email:</span>{' '}
              <span className="font-medium">{email}</span>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              The user will no longer be able to log in to the portal.
              You can re-create the portal login later if needed.
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
                onClick={handleDelete}
                disabled={isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
                Delete Portal User
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
