'use client'

import { useState, useEffect, useActionState } from 'react'
import { Check, Circle, Share2, Banknote, ChevronDown, Copy, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { REFERRAL_STAGES, REFERRAL_STAGE_LABELS, type ReferralStage } from '@/lib/portal/partner-referrals'
import { requestPartnerPayout, type RequestPayoutState } from '@/app/portal/partner/referrals/actions'

export interface PartnerReferralView {
  offerToken: string
  clientName: string
  createdAt: string | null
  progress: Record<ReferralStage, boolean>
  /** One-time acquisition reward. */
  payouts: Array<{
    id: string
    type: 'setup'
    amount: number
    currency: string
    status: string
    requestedAt: string | null
  }>
  /** Recurring annual renewals — per year, per installment invoice (issued→paid)
      with the partner's OWN share. Only renewal years (after formation) with a
      real installment invoice appear. */
  renewals: Array<{
    year: number
    installments: Array<{
      n: number
      label: string
      invoicePaid: boolean
      paidDate: string | null
      amount: number
      currency: string
      payoutId: string | null
      payoutStatus: string | null
    }>
  }>
}

const money = (amt: number, cur: string) =>
  `${cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur + ' '}${amt.toLocaleString('en-US', { minimumFractionDigits: 0 })}`

const PAYOUT_BADGE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  requested: 'bg-blue-100 text-blue-800',
  approved: 'bg-indigo-100 text-indigo-800',
  paid: 'bg-emerald-100 text-emerald-800',
  manual_review: 'bg-red-100 text-red-800',
}
const PAYOUT_LABEL: Record<string, string> = {
  pending: 'Available to request',
  requested: 'Requested — awaiting payment',
  approved: 'Approved',
  paid: 'Paid',
  manual_review: 'Under review',
}

export function PartnerReferralsClient({ referrals }: { partnerName?: string; referrals: PartnerReferralView[] }) {
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">My Referrals</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          Share your link, track each client&rsquo;s progress, and request your payout once they&rsquo;ve paid.
        </p>
      </div>

      <ReferralLinkCard />

      {referrals.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Share2 className="h-8 w-8 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-zinc-600">No referrals yet</p>
          <p className="text-xs text-zinc-400 mt-1">Clients you refer will appear here with their progress.</p>
        </div>
      ) : (
        referrals.map((r) => <ReferralCard key={r.offerToken} referral={r} />)
      )}
    </div>
  )
}

function ReferralLinkCard() {
  const [link, setLink] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/portal/referral-code')
      .then((r) => (r.ok ? r.json() : { link: null }))
      .then((d) => { if (active) setLink(d.link ?? null) })
      .catch(() => { if (active) setLink(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const copy = () => {
    if (!link) return
    navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-gradient-to-r from-violet-50 to-indigo-50 rounded-xl border border-violet-200 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
          <Share2 className="h-4.5 w-4.5 text-violet-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm text-zinc-900">Your referral link</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Share it with a prospect — they book a call, and their progress shows below.</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 bg-white rounded-lg border px-3 py-2 text-xs sm:text-sm text-zinc-700 truncate font-mono">
              {loading ? 'Loading…' : (link ?? 'Link unavailable — contact us')}
            </div>
            <button
              onClick={copy}
              disabled={!link}
              className={cn('shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50',
                copied ? 'bg-emerald-500 text-white' : 'bg-violet-600 text-white hover:bg-violet-700')}
            >
              <span className="flex items-center gap-1.5">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ReferralCard({ referral }: { referral: PartnerReferralView }) {
  const setupPayouts = referral.payouts
  return (
    <div className="bg-white rounded-xl border shadow-sm p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-zinc-900">{referral.clientName}</p>
        {referral.createdAt && (
          <p className="text-xs text-zinc-400">{referral.createdAt.slice(0, 10)}</p>
        )}
      </div>

      {/* Progress stepper */}
      <div className="flex flex-wrap gap-x-1 gap-y-2">
        {REFERRAL_STAGES.map((stage, i) => {
          const done = referral.progress[stage]
          return (
            <div key={stage} className="flex items-center">
              <div className="flex items-center gap-1.5">
                {done ? (
                  <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                    <Check className="h-3 w-3" />
                  </span>
                ) : (
                  <span className="w-5 h-5 rounded-full border border-zinc-300 text-zinc-300 flex items-center justify-center shrink-0">
                    <Circle className="h-2 w-2" />
                  </span>
                )}
                <span className={cn('text-xs', done ? 'text-zinc-800 font-medium' : 'text-zinc-400')}>
                  {REFERRAL_STAGE_LABELS[stage]}
                </span>
              </div>
              {i < REFERRAL_STAGES.length - 1 && <span className="mx-1.5 text-zinc-200">›</span>}
            </div>
          )
        })}
      </div>

      {/* Setup payout — the one-time acquisition reward (end of the funnel). */}
      {setupPayouts.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          {setupPayouts.map((p) => (
            <PayoutRow key={p.id} payout={p} />
          ))}
        </div>
      )}

      {/* Annual renewals — recurring billing cycle (R106). Per year, each
          installment invoice (issued → paid) with the partner's OWN share; the
          payout is requestable once that installment is paid. */}
      {referral.renewals.length > 0 && (
        <div className="border-t pt-3 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3" /> Annual renewals
          </p>
          {referral.renewals.map((ry) => (
            <div key={ry.year} className="space-y-1.5">
              <p className="text-xs font-semibold text-zinc-700">{ry.year}</p>
              {ry.installments.map((inst) => (
                <RenewalInstallmentRow key={inst.n} inst={inst} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RenewalInstallmentRow({ inst }: { inst: PartnerReferralView['renewals'][number]['installments'][number] }) {
  const [open, setOpen] = useState(false)
  const canRequest = inst.invoicePaid && !!inst.payoutId && inst.payoutStatus === 'pending'
  return (
    <div className="rounded-lg bg-zinc-50 border border-zinc-100 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Banknote className="h-4 w-4 text-zinc-400 shrink-0" />
          <span className="text-sm text-zinc-800">
            {inst.label} · <b>{money(inst.amount, inst.currency)}</b>
          </span>
        </div>
        <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0',
          inst.invoicePaid ? 'bg-emerald-100 text-emerald-800' : 'bg-zinc-100 text-zinc-600')}>
          {inst.invoicePaid
            ? `Invoice paid${inst.paidDate ? ' · ' + inst.paidDate.slice(0, 10) : ''}`
            : 'Invoice issued'}
        </span>
      </div>
      <div className="mt-2">
        {!inst.invoicePaid ? (
          <p className="text-[11px] text-zinc-400">Your payout becomes available to request once this installment is paid.</p>
        ) : inst.payoutStatus && inst.payoutStatus !== 'pending' ? (
          <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium', PAYOUT_BADGE[inst.payoutStatus] || 'bg-zinc-100 text-zinc-600')}>
            {PAYOUT_LABEL[inst.payoutStatus] || inst.payoutStatus}
          </span>
        ) : canRequest ? (
          <>
            <button
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:text-violet-900"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
              {open ? 'Hide' : 'Request this payout'}
            </button>
            {open && inst.payoutId && <PayoutRequestForm payoutId={inst.payoutId} />}
          </>
        ) : (
          <p className="text-[11px] text-zinc-400">Your payout is being prepared.</p>
        )}
      </div>
    </div>
  )
}

function PayoutRow({ payout }: { payout: PartnerReferralView['payouts'][number] }) {
  const [open, setOpen] = useState(false)
  const requestable = payout.status === 'pending'
  return (
    <div className="rounded-lg bg-zinc-50 border border-zinc-100 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Banknote className="h-4 w-4 text-zinc-400 shrink-0" />
          <span className="text-sm text-zinc-800">
            Setup payout · <b>{money(payout.amount, payout.currency)}</b>
          </span>
        </div>
        <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0', PAYOUT_BADGE[payout.status] || 'bg-zinc-100 text-zinc-600')}>
          {PAYOUT_LABEL[payout.status] || payout.status}
        </span>
      </div>

      {requestable && (
        <div className="mt-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:text-violet-900"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
            {open ? 'Hide' : 'Request this payout'}
          </button>
          {open && <PayoutRequestForm payoutId={payout.id} />}
        </div>
      )}
    </div>
  )
}

const initialState: RequestPayoutState = { ok: false }

function PayoutRequestForm({ payoutId }: { payoutId: string }) {
  const [state, formAction, pending] = useActionState(requestPartnerPayout, initialState)

  if (state.ok && state.payoutId === payoutId) {
    return (
      <p className="mt-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
        ✓ Payout requested. We&rsquo;ll process the bank transfer and update the status here.
      </p>
    )
  }

  return (
    <form action={formAction} className="mt-2 space-y-2">
      <input type="hidden" name="payout_id" value={payoutId} />
      <p className="text-[11px] text-zinc-500">Enter your <b>USD</b> bank details. Optionally attach your invoice.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input name="account_name" required placeholder="Account holder name *" className="border rounded px-2 py-1.5 text-sm" />
        <input name="bank_name" placeholder="Bank name" className="border rounded px-2 py-1.5 text-sm" />
        <input name="account_number" placeholder="Account number" className="border rounded px-2 py-1.5 text-sm" />
        <input name="iban" placeholder="IBAN" className="border rounded px-2 py-1.5 text-sm" />
        <input name="swift_bic" placeholder="SWIFT / BIC" className="border rounded px-2 py-1.5 text-sm" />
        <input name="note" placeholder="Note (optional)" className="border rounded px-2 py-1.5 text-sm" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input name="invoice" type="file" accept=".pdf,.png,.jpg,.jpeg" className="text-xs text-zinc-600 file:mr-2 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-xs" />
      </div>
      <p className="text-[11px] text-zinc-400">Provide the account holder name and an account number or IBAN.</p>
      {state.error && state.payoutId === payoutId && (
        <p className="text-xs text-red-600">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60"
      >
        {pending ? 'Submitting…' : 'Submit payout request'}
      </button>
    </form>
  )
}
