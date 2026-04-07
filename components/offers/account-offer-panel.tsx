'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileText, Send, Trash2, RotateCcw, ExternalLink, Loader2, Eye,
} from 'lucide-react'
import { toast } from 'sonner'
import { CreateOfferDialog } from './create-offer-dialog'

const OFFER_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-700',
  sent: 'bg-blue-100 text-blue-700',
  viewed: 'bg-amber-100 text-amber-700',
  signed: 'bg-indigo-100 text-indigo-700',
  completed: 'bg-emerald-100 text-emerald-700',
  expired: 'bg-red-100 text-red-700',
}

interface OfferData {
  token: string
  status: string
  contract_type: string | null
  cost_summary: Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null
  view_count: number
  viewed_at: string | null
  created_at: string
  required_documents: Array<{ id: string; name: string }> | null
}

interface AccountOfferPanelProps {
  accountId: string
  companyName: string
  clientEmail: string
  clientLanguage?: string | null
  offer: OfferData | null
  isAdmin: boolean
}

export function AccountOfferPanel({
  accountId,
  companyName,
  clientEmail,
  clientLanguage,
  offer,
  isAdmin,
}: AccountOfferPanelProps) {
  const router = useRouter()
  const [showCreateOffer, setShowCreateOffer] = useState(false)
  const [sendingOffer, setSendingOffer] = useState(false)
  const [deletingOffer, setDeletingOffer] = useState(false)
  const [resettingOffer, setResettingOffer] = useState(false)

  if (!isAdmin) return null

  const hasOffer = !!offer
  const isOfferDraft = hasOffer && offer.status === 'draft'
  // APP_BASE_URL is passed from server or falls back to production
  const appBaseUrl = 'https://app.tonydurante.us'

  const doSendOffer = async () => {
    if (!offer?.token) return
    if (!confirm(`Send offer ${offer.token} to ${clientEmail}?\n\nThis will create a portal login and email the client their credentials.`)) return

    setSendingOffer(true)
    try {
      const res = await fetch('/api/crm/admin-actions/send-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_token: offer.token }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to send offer')
        return
      }
      toast.success(data.message || 'Offer sent!')
      if (data.portal_created) {
        toast.success('Portal user created -- client will receive login credentials')
      }
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSendingOffer(false)
    }
  }

  const doDeleteOffer = async () => {
    if (!offer?.token) return
    if (!confirm(`Delete offer ${offer.token}? This will also delete associated contracts and activations.`)) return

    setDeletingOffer(true)
    try {
      const res = await fetch('/api/crm/admin-actions/delete-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_token: offer.token }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete offer')
        return
      }
      toast.success(data.message || 'Offer deleted')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setDeletingOffer(false)
    }
  }

  const doResetOffer = async () => {
    if (!offer?.token) return
    if (!confirm(`Reset offer ${offer.token} to draft? This will delete contracts and pending activations.`)) return

    setResettingOffer(true)
    try {
      const res = await fetch('/api/crm/admin-actions/reset-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_token: offer.token }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to reset offer')
        return
      }
      toast.success(data.message || 'Offer reset to draft')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setResettingOffer(false)
    }
  }

  return (
    <>
      <div className="bg-white rounded-lg border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <FileText className="h-4 w-4" />
            Offer
          </h3>
        </div>

        {!hasOffer ? (
          /* No offer -- show create button */
          <div className="text-center py-4">
            <p className="text-sm text-zinc-500 mb-3">No offer exists for this account</p>
            <button
              onClick={() => {
                if (!clientEmail) {
                  toast.error('Account needs a contact with an email before creating an offer')
                  return
                }
                setShowCreateOffer(true)
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              <FileText className="h-4 w-4" />
              Create Offer
            </button>
          </div>
        ) : (
          /* Offer exists -- show details + actions */
          <div className="space-y-3">
            {/* Status row */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-sm text-blue-600 font-medium">{offer.token}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${OFFER_STATUS_COLORS[offer.status] || 'bg-zinc-100 text-zinc-700'}`}>
                {offer.status}
              </span>
              {offer.contract_type && (
                <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">
                  {offer.contract_type}
                </span>
              )}
              {offer.view_count > 0 && (
                <span className="text-xs text-zinc-500 flex items-center gap-1">
                  <Eye className="h-3 w-3" /> {offer.view_count} views
                </span>
              )}
            </div>

            {/* Cost summary */}
            {offer.cost_summary && offer.cost_summary.length > 0 && (
              <div className="bg-zinc-50 rounded-lg p-3 text-sm">
                {offer.cost_summary.map((group, i) => (
                  <div key={i}>
                    {group.items?.map((item, j) => (
                      <div key={j} className="flex justify-between text-xs">
                        <span className="text-zinc-600">{item.name}</span>
                        <span className="font-medium">{item.price}</span>
                      </div>
                    ))}
                    {group.total && (
                      <div className="flex justify-between mt-1 pt-1 border-t border-zinc-200">
                        <span className="text-xs font-medium">{group.label}</span>
                        <span className="text-sm font-bold">{group.total}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Required documents */}
            {offer.required_documents && offer.required_documents.length > 0 && (
              <div className="bg-orange-50 rounded-lg p-3">
                <p className="text-xs font-medium text-orange-800 mb-1">Required Documents:</p>
                <div className="flex flex-wrap gap-1">
                  {offer.required_documents.map((doc) => (
                    <span key={doc.id} className="text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-700">
                      {doc.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-2">
              {/* View Offer */}
              <a
                href={`${appBaseUrl}/offer/${offer.token}?preview=td`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View Offer
              </a>

              {/* Send Offer (draft only) */}
              {isOfferDraft && clientEmail && (
                <button
                  onClick={doSendOffer}
                  disabled={sendingOffer}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
                >
                  {sendingOffer ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send Offer
                </button>
              )}

              {/* Reset Offer (not draft) */}
              {offer.status !== 'draft' && (
                <button
                  onClick={doResetOffer}
                  disabled={resettingOffer}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50 transition-colors"
                >
                  {resettingOffer ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Reset to Draft
                </button>
              )}

              {/* Delete Offer */}
              <button
                onClick={doDeleteOffer}
                disabled={deletingOffer}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {deletingOffer ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete Offer
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create Offer Dialog */}
      <CreateOfferDialog
        open={showCreateOffer}
        onClose={() => setShowCreateOffer(false)}
        accountId={accountId}
        clientName={companyName}
        clientEmail={clientEmail}
        clientLanguage={clientLanguage}
      />
    </>
  )
}
