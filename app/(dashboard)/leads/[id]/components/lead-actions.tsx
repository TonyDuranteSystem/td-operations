'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CreditCard, UserPlus, XCircle,
  Loader2, FileText, Rocket, Trash2, RotateCcw, UserX,
} from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmPaymentDialog } from './confirm-payment-dialog'
import { ConvertLeadDialog } from './convert-lead-dialog'
import { CreateOfferDialog } from './create-offer-dialog'
import { ActivateLeadDialog } from './activate-lead-dialog'
import {
  DeleteLeadDialog,
  DeleteOfferDialog,
  ResetOfferDialog,
  DeletePortalUserDialog,
} from './delete-lead-dialog'

interface OfferData {
  token: string
  status: string
  contract_type: string | null
  bundled_pipelines: string[] | null
  cost_summary: Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null
}

interface ActivationData {
  id: string
  status: string
}

interface LeadActionsProps {
  leadId: string
  leadName: string
  leadEmail?: string | null
  leadStatus: string
  leadLanguage?: string | null
  leadReferrer?: string | null
  leadReferrerType?: string | null
  offer: OfferData | null
  activation: ActivationData | null
  isAdmin?: boolean
  hasPortalUser?: boolean
}

export function LeadActions({
  leadId,
  leadName,
  leadEmail,
  leadStatus,
  leadLanguage,
  leadReferrer,
  leadReferrerType,
  offer,
  activation,
  isAdmin = false,
  hasPortalUser = false,
}: LeadActionsProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showCreateOffer, setShowCreateOffer] = useState(false)
  const [showActivateLead, setShowActivateLead] = useState(false)
  const [showConfirmPayment, setShowConfirmPayment] = useState(false)
  const [showConvert, setShowConvert] = useState(false)
  const [showLostReason, setShowLostReason] = useState(false)
  const [lostReason, setLostReason] = useState('')

  // Delete/reset dialogs
  const [showDeleteLead, setShowDeleteLead] = useState(false)
  const [showDeleteOffer, setShowDeleteOffer] = useState(false)
  const [showResetOffer, setShowResetOffer] = useState(false)
  const [showDeletePortalUser, setShowDeletePortalUser] = useState(false)

  const isConverted = leadStatus === 'Converted'
  const isLost = leadStatus === 'Lost'
  const isActivated = activation?.status === 'activated'
  const hasOffer = !!offer
  const hasEmail = !!leadEmail
  const isOfferSentOrBeyond = ['Offer Sent', 'Negotiating', 'Converted'].includes(leadStatus)

  // Sequential unlock logic
  const canCreateOffer = !hasOffer && !isConverted && !isLost
  const canActivateLead = hasOffer && hasEmail && !isOfferSentOrBeyond && !isConverted && !isLost
  const canConfirmPayment = !isConverted && !isActivated
  const canConvert = !isConverted
  const canMarkLost = !isConverted && !isLost

  const doMarkLost = () => {
    if (!lostReason.trim()) {
      toast.error('Reason is required')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/mark-lost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: leadId,
            reason: lostReason.trim(),
          }),
        })

        if (!res.ok) {
          const data = await res.json()
          toast.error(data.error || 'Failed to mark as lost')
          return
        }

        toast.success(`${leadName} marked as Lost`)
        setShowLostReason(false)
        setLostReason('')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  if (isConverted && isActivated) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
        <p className="text-sm font-medium text-emerald-800">
          This lead has been converted and activated. Check the Contact and Account pages for details.
        </p>
      </div>
    )
  }

  // Team members can see lead details but not perform admin actions
  if (!isAdmin) {
    return (
      <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-4">
        <p className="text-sm text-zinc-600">
          Lead actions are admin-only. Contact Antonio to manage this lead.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="bg-white rounded-lg border p-5">
        <h2 className="text-sm font-semibold text-zinc-900 mb-4">Admin Actions</h2>

        <div className="flex flex-wrap gap-2">
          {/* Step 1: Create Offer */}
          {canCreateOffer && (
            <button
              onClick={() => {
                if (!hasEmail) {
                  toast.error('Lead needs an email before creating an offer')
                  return
                }
                setShowCreateOffer(true)
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              <FileText className="h-4 w-4" />
              Create Offer
            </button>
          )}

          {/* Step 2: Activate Lead (enabled only after offer exists) */}
          {canActivateLead && (
            <button
              onClick={() => setShowActivateLead(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              <Rocket className="h-4 w-4" />
              Activate Lead
            </button>
          )}

          {/* Disabled state hints */}
          {hasOffer && !hasEmail && !isConverted && !isLost && (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-amber-700 bg-amber-50 rounded-md border border-amber-200">
              Lead needs an email to activate
            </span>
          )}

          {/* Step 3: Confirm Payment */}
          {canConfirmPayment && (
            <button
              onClick={() => setShowConfirmPayment(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              <CreditCard className="h-4 w-4" />
              Confirm Payment
            </button>
          )}

          {/* Convert to Contact */}
          {canConvert && (
            <button
              onClick={() => setShowConvert(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 transition-colors"
            >
              <UserPlus className="h-4 w-4" />
              Convert to Contact
            </button>
          )}

          {/* Mark as Lost */}
          {canMarkLost && !showLostReason && (
            <button
              onClick={() => setShowLostReason(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 transition-colors"
            >
              <XCircle className="h-4 w-4" />
              Mark as Lost
            </button>
          )}
        </div>

        {/* Offer exists hint */}
        {hasOffer && !isConverted && (
          <p className="text-xs text-zinc-500 mt-3">
            Offer: <span className="font-medium text-blue-600">{offer.token}</span>
            {' '}&middot;{' '}
            <span className={offer.status === 'signed' ? 'text-emerald-600 font-medium' : ''}>
              {offer.status}
            </span>
          </p>
        )}

        {/* Inline lost reason */}
        {showLostReason && (
          <div className="mt-3 p-3 bg-zinc-50 rounded-lg space-y-2">
            <label className="block text-sm font-medium">Why is this lead lost?</label>
            <textarea
              value={lostReason}
              onChange={e => setLostReason(e.target.value)}
              rows={2}
              autoFocus
              placeholder="e.g. Not interested, went with competitor, no response..."
              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={doMarkLost}
                disabled={isPending || !lostReason.trim()}
                className="px-3 py-1.5 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-1.5"
              >
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                Confirm Lost
              </button>
              <button
                onClick={() => { setShowLostReason(false); setLostReason('') }}
                className="px-3 py-1.5 text-sm border rounded-md hover:bg-zinc-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ─── Danger Zone ─── */}
        <div className="mt-5 pt-4 border-t border-red-200">
          <h3 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-3">Danger Zone</h3>
          <div className="flex flex-wrap gap-2">
            {/* Delete Offer (only if offer exists) */}
            {hasOffer && (
              <button
                onClick={() => setShowDeleteOffer(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Delete Offer
              </button>
            )}

            {/* Reset Offer (only if offer exists and not already draft) */}
            {hasOffer && offer.status !== 'draft' && (
              <button
                onClick={() => setShowResetOffer(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors"
              >
                <RotateCcw className="h-4 w-4" />
                Reset Offer
              </button>
            )}

            {/* Delete Portal User (only if email exists and portal user detected) */}
            {hasEmail && hasPortalUser && (
              <button
                onClick={() => setShowDeletePortalUser(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
              >
                <UserX className="h-4 w-4" />
                Delete Portal User
              </button>
            )}

            {/* Delete Lead (always available for admin) */}
            <button
              onClick={() => setShowDeleteLead(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              Delete Lead
            </button>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <CreateOfferDialog
        open={showCreateOffer}
        onClose={() => setShowCreateOffer(false)}
        leadId={leadId}
        leadName={leadName}
        leadEmail={leadEmail || ''}
        leadLanguage={leadLanguage}
        leadReferrer={leadReferrer}
        leadReferrerType={leadReferrerType}
      />

      <ActivateLeadDialog
        open={showActivateLead}
        onClose={() => setShowActivateLead(false)}
        leadId={leadId}
        leadName={leadName}
        leadEmail={leadEmail || ''}
        offerToken={offer?.token || null}
      />

      <ConfirmPaymentDialog
        open={showConfirmPayment}
        onClose={() => setShowConfirmPayment(false)}
        leadId={leadId}
        leadName={leadName}
        offer={offer}
      />

      <ConvertLeadDialog
        open={showConvert}
        onClose={() => setShowConvert(false)}
        leadId={leadId}
        leadName={leadName}
      />

      {/* Delete / Reset dialogs */}
      <DeleteLeadDialog
        open={showDeleteLead}
        onClose={() => setShowDeleteLead(false)}
        leadId={leadId}
        leadName={leadName}
      />

      {hasOffer && (
        <>
          <DeleteOfferDialog
            open={showDeleteOffer}
            onClose={() => setShowDeleteOffer(false)}
            offerToken={offer.token}
            leadName={leadName}
          />

          <ResetOfferDialog
            open={showResetOffer}
            onClose={() => setShowResetOffer(false)}
            offerToken={offer.token}
            leadName={leadName}
          />
        </>
      )}

      {hasEmail && (
        <DeletePortalUserDialog
          open={showDeletePortalUser}
          onClose={() => setShowDeletePortalUser(false)}
          email={leadEmail!}
          leadName={leadName}
        />
      )}
    </>
  )
}
