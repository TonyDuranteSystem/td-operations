'use client'

import { useState } from 'react'
import { FileText, CheckCircle2, Clock, AlertTriangle, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

interface SS4ApplicationRecord {
  id: string
  token: string
  account_id: string
  company_name: string
  status: string
  signed_at: string | null
  pdf_signed_drive_id: string | null
}

interface ServiceDelivery {
  id: string
  service_type: string
  stage: string | null
  status: string
  account_id: string | null
}

interface LinkedAccount {
  id: string
  company_name: string
  ein: string | null
}

// ─── Timeline step states ─────────────────────────────────────────────────
type StepState = 'done' | 'current' | 'pending'

function getStepStates(ss4Status: string, hasEin: boolean): StepState[] {
  // Steps: [Created, Signed, Fax Sent, EIN Received]
  if (hasEin) return ['done', 'done', 'done', 'done']
  if (ss4Status === 'submitted') return ['done', 'done', 'done', 'current']
  if (ss4Status === 'signed' || ss4Status === 'fax_failed') return ['done', 'done', 'current', 'pending']
  if (ss4Status === 'draft') return ['done', 'current', 'pending', 'pending']
  return ['current', 'pending', 'pending', 'pending']
}

const STEP_LABELS = ['SS-4 Created', 'Client Signed', 'Fax Sent', 'EIN Received']

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-zinc-100 text-zinc-600' },
  signed: { label: 'Signed', className: 'bg-blue-100 text-blue-700' },
  submitted: { label: 'Fax Sent', className: 'bg-emerald-100 text-emerald-700' },
  fax_failed: { label: 'Fax Failed', className: 'bg-red-100 text-red-700' },
}

export function SS4PipelineCard({
  ss4Applications,
  serviceDeliveries,
  accounts,
  contactId,
}: {
  ss4Applications: SS4ApplicationRecord[]
  serviceDeliveries: ServiceDelivery[]
  accounts: LinkedAccount[]
  contactId: string
}) {
  const [loading, setLoading] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const ss4 = ss4Applications[0]
  if (!ss4) return null

  const account = accounts.find(a => a.id === ss4.account_id)
  const hasEin = !!account?.ein
  const stepStates = getStepStates(ss4.status, hasEin)
  const badge = STATUS_BADGES[ss4.status] || STATUS_BADGES.draft

  // Find the formation SD for this account
  const formationSd = serviceDeliveries.find(
    sd => sd.account_id === ss4.account_id && sd.service_type === 'Company Formation' && sd.status === 'active',
  )

  const showMarkFaxButton = ss4.status === 'signed' || ss4.status === 'fax_failed'

  const handleMarkFaxSent = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: 'mark_fax_sent',
          params: {
            ss4_id: ss4.id,
            delivery_id: formationSd?.id,
          },
        }),
      })
      const result = await res.json()
      if (result.success) {
        toast.success(result.detail)
        if (result.side_effects?.length) {
          toast.info(result.side_effects.join(' | '))
        }
        setConfirmOpen(false)
        window.location.reload()
      } else {
        toast.error(result.detail || 'Failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <FileText className="h-4 w-4" />
          EIN Application
        </h3>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {/* Company name */}
      <div className="text-sm text-zinc-600">
        {ss4.company_name}
        {formationSd?.stage && (
          <span className="ml-2 text-xs text-muted-foreground">
            Pipeline: {formationSd.stage}
          </span>
        )}
      </div>

      {/* Mini timeline */}
      <div className="flex items-center gap-1">
        {STEP_LABELS.map((label, i) => {
          const state = stepStates[i]
          return (
            <div key={label} className="flex-1 flex flex-col items-center gap-1">
              {/* Connector + circle */}
              <div className="flex items-center w-full">
                {i > 0 && (
                  <div className={`flex-1 h-0.5 ${
                    state === 'pending' ? 'bg-zinc-200' : 'bg-emerald-400'
                  }`} />
                )}
                <div className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 ${
                  state === 'done' ? 'bg-emerald-500 text-white' :
                  state === 'current' ? 'bg-blue-500 text-white ring-2 ring-blue-200' :
                  'bg-zinc-200 text-zinc-400'
                }`}>
                  {state === 'done' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : state === 'current' ? (
                    <Clock className="h-3.5 w-3.5" />
                  ) : (
                    <span className="text-[10px] font-bold">{i + 1}</span>
                  )}
                </div>
                {i < STEP_LABELS.length - 1 && (
                  <div className={`flex-1 h-0.5 ${
                    stepStates[i + 1] === 'pending' ? 'bg-zinc-200' : 'bg-emerald-400'
                  }`} />
                )}
              </div>
              {/* Label */}
              <span className={`text-[10px] text-center leading-tight ${
                state === 'done' ? 'text-emerald-700 font-medium' :
                state === 'current' ? 'text-blue-700 font-medium' :
                'text-zinc-400'
              }`}>
                {label}
              </span>
            </div>
          )
        })}
      </div>

      {/* Signed date */}
      {ss4.signed_at && (
        <div className="text-xs text-muted-foreground">
          Signed: {ss4.signed_at.split('T')[0]}
        </div>
      )}

      {/* Action section */}
      {showMarkFaxButton && (
        <button
          onClick={() => setConfirmOpen(true)}
          className={`w-full py-2 px-4 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
            ss4.status === 'fax_failed'
              ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
              : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
          }`}
        >
          <Send className="h-4 w-4" />
          {ss4.status === 'fax_failed' ? 'Retry: Mark Fax as Sent' : 'Mark Fax as Sent'}
        </button>
      )}

      {ss4.status === 'submitted' && !hasEin && (
        <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <Clock className="h-5 w-5 text-blue-600 shrink-0 animate-pulse" />
          <div>
            <div className="text-sm font-medium text-blue-800">Waiting for IRS response</div>
            <div className="text-xs text-blue-600">EIN typically arrives within 4-7 business days</div>
          </div>
        </div>
      )}

      {hasEin && (
        <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-lg border border-emerald-200">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <div className="text-sm font-medium text-emerald-800">EIN Received</div>
            <div className="text-xs text-emerald-600">{account?.ein}</div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Confirm Fax Sent
            </h3>

            <div className="text-sm space-y-2">
              <p>Confirm that the SS-4 for <strong>{ss4.company_name}</strong> was faxed to the IRS at (855) 641-6935.</p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <p className="font-medium mb-1">What happens:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>SS-4 status set to &quot;submitted&quot;</li>
                <li>Pipeline advances to &quot;EIN Submitted&quot;</li>
                <li>Open fax tasks marked as Done</li>
                <li>New tasks created for EIN follow-up</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={handleMarkFaxSent}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Processing...
                  </span>
                ) : (
                  'Confirm Fax Sent'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
