'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CreditCard, UserPlus, XCircle,
  Loader2, FileText, Rocket, Trash2, RotateCcw, UserX, Send,
  MessageCircle, GitBranch,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
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
  contactId?: string | null
  offer: OfferData | null
  activation: ActivationData | null
  isAdmin?: boolean // kept for interface compat, no longer gates UI
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
  contactId,
  offer,
  activation,
  isAdmin: _isAdmin = false,
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

  // Send/resend/revise offer state
  const [sendingOffer, setSendingOffer] = useState(false)
  const [resendingOffer, setResendingOffer] = useState(false)
  const [revisingOffer, setRevisingOffer] = useState(false)
  const [settingDiscussion, setSettingDiscussion] = useState(false)

  const isConverted = leadStatus === 'Converted'
  const isLost = leadStatus === 'Lost'
  const isActivated = activation?.status === 'activated'
  const hasOffer = !!offer
  const hasEmail = !!leadEmail
  const isOfferSentOrBeyond = ['Offer Sent', 'Negotiating', 'Converted'].includes(leadStatus)
  const isOfferDraft = hasOffer && offer.status === 'draft'
  const isOfferPublished = hasOffer && offer.status !== 'draft'

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

  const doSendOffer = async () => {
    if (!offer?.token) return
    if (!confirm(`Send offer ${offer.token} to ${leadEmail}?\n\nThis will create a portal login and email the client their credentials.`)) return

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
        toast.success('Portal user created — client will receive login credentials')
      }
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSendingOffer(false)
    }
  }

  const doResendOffer = async () => {
    if (!offer?.token) return
    if (!confirm(`Re-send portal reminder email to ${leadEmail}?\n\nThis is email-only — no status change, no republish, no new version.`)) return

    setResendingOffer(true)
    try {
      const res = await fetch('/api/crm/admin-actions/resend-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_token: offer.token }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to resend')
        return
      }
      toast.success(data.message || 'Reminder email sent')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setResendingOffer(false)
    }
  }

  const doReviseOffer = async () => {
    if (!offer?.token) return
    if (!confirm(`Create a revised version of this offer?\n\nThe current offer will be marked "superseded" and a new draft (v2) will be created with the same content.\n\nThe original offer is preserved — not deleted.`)) return

    setRevisingOffer(true)
    try {
      const res = await fetch('/api/crm/admin-actions/revise-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_token: offer.token }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to revise offer')
        return
      }
      toast.success(`Revised → v${data.version} draft created`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setRevisingOffer(false)
    }
  }

  const doSetUnderDiscussion = async () => {
    if (!offer?.token) return
    const isAlreadyDiscussion = offer.status === 'under_discussion'
    const label = isAlreadyDiscussion ? 'Move back to Published' : 'Mark as Under Discussion'

    if (!confirm(`${label}?\n\nThis changes the offer status only — no email sent, no content changed.`)) return

    setSettingDiscussion(true)
    try {
      const { toggleOfferDiscussion } = await import('../actions')
      const result = await toggleOfferDiscussion(offer.token, leadId)
      if (result.success) {
        toast.success(result.newStatus === 'under_discussion' ? 'Marked as Under Discussion' : 'Moved back to Published')
        router.refresh()
      } else {
        toast.error(result.error || 'Failed to update status')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSettingDiscussion(false)
    }
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

  return (
    <>
      <div className="bg-white rounded-lg border p-5">
        <h2 className="text-sm font-semibold text-zinc-900 mb-4">Actions</h2>

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

          {/* Send Offer (when offer exists in draft) */}
          {isOfferDraft && hasEmail && (
            <button
              onClick={doSendOffer}
              disabled={sendingOffer}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
            >
              {sendingOffer ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send Offer
            </button>
          )}

          {/* Revise Offer (creates new version, supersedes current) */}
          {isOfferPublished && offer?.status !== 'signed' && offer?.status !== 'completed' && offer?.status !== 'superseded' && (
            <button
              onClick={doReviseOffer}
              disabled={revisingOffer}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-blue-300 text-blue-700 hover:bg-blue-50 disabled:opacity-50 transition-colors"
            >
              {revisingOffer ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
              Revise Offer
            </button>
          )}

          {/* Under Discussion toggle */}
          {isOfferPublished && offer?.status !== 'signed' && offer?.status !== 'completed' && offer?.status !== 'superseded' && (
            <button
              onClick={doSetUnderDiscussion}
              disabled={settingDiscussion}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border disabled:opacity-50 transition-colors',
                offer?.status === 'under_discussion'
                  ? 'border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100'
                  : 'border-zinc-300 text-zinc-600 hover:bg-zinc-50'
              )}
            >
              {settingDiscussion ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
              {offer?.status === 'under_discussion' ? 'End Discussion' : 'Under Discussion'}
            </button>
          )}

          {/* Resend Email (when offer already published) */}
          {isOfferPublished && hasEmail && (
            <button
              onClick={doResendOffer}
              disabled={resendingOffer}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
            >
              {resendingOffer ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Resend Email
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
        contactId={contactId}
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
