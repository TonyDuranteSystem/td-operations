'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney, isExpiredLink, parseAmountToCents, saleStatusLabel, type SaleRow } from '@/lib/marketing/sales'
import { splitCents } from '@/lib/marketing/commission'

interface Option { key: string; label: string }
export interface PaymentLinkProps {
  leadId: string
  kinds: Option[]
  currencies: string[]
  confirmAbove: number | null
  /** the split in force for THIS seller, per kind (null = terms not set) */
  splits: Record<string, { sellerPct: number; tdPct: number; basis: string } | null>
  sales: SaleRow[]
}

/** The "Payment link" box on a lead: kind, amount, currency, the split that will be saved, then the link to copy. Every server answer is shown as written. */
export function PaymentLinkPanel({ leadId, kinds, currencies, confirmAbove, splits, sales }: PaymentLinkProps) {
  const router = useRouter()
  const [kind, setKind] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const cents = parseAmountToCents(amount)
  const term = kind ? splits[kind] ?? null : null
  const split = cents !== null && term && term.basis === 'amount_paid' ? splitCents(cents, term.sellerPct) : null
  const big = cents !== null && confirmAbove !== null && cents / 100 > confirmAbove

  async function create() {
    setBusy(true); setError(null); setUrl(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/payment-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, amount, currency, note: note || null, confirmed }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create the link. Please try again.')
      setUrl(d.url)
      setAmount(''); setNote(''); setConfirmed(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not create the link. Please try again.')
    } finally { setBusy(false) }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { setError('Could not copy. Select the link and copy it by hand.') }
  }

  const input = 'mt-1 w-full rounded-lg border px-3 py-2'
  return (
    <section className="mt-5 rounded-xl border bg-white p-4" aria-label="Payment link">
      <h2 className="text-sm font-semibold text-slate-600">Payment link</h2>
      <p className="mt-1 text-xs text-slate-500">Card payment through Stripe. When the client pays, the sale is recorded here by itself.</p>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <label className="block"><span className="text-slate-500">What is it for?</span>
          <select className={input} value={kind} onChange={e => setKind(e.target.value)}>
            <option value="">Pick…</option>{kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select></label>
        <label className="block"><span className="text-slate-500">Amount</span>
          <input className={input} inputMode="decimal" placeholder="1500" value={amount} onChange={e => { setAmount(e.target.value); setConfirmed(false) }} /></label>
        <label className="block"><span className="text-slate-500">Currency</span>
          <select className={input} value={currency} onChange={e => setCurrency(e.target.value)}>{currencies.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <label className="mt-3 block text-sm"><span className="text-slate-500">Note (optional, only you and Antonio see it)</span>
        <input className={input} maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></label>

      {kind && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm" data-testid="split-preview">
          {term === null ? <>Terms not set for this kind of sale yet. The sale will be recorded and Antonio sets the split afterwards.</>
            : term.basis !== 'amount_paid' ? <>The split for this kind is {term.sellerPct}% / {term.tdPct}% of what is left after card fees; the amounts are set by Antonio after payment.</>
            : split ? <>Your share {term.sellerPct}% = <b>{formatMoney(split.sellerCents, currency)}</b> · TD {term.tdPct}% = <b>{formatMoney(split.tdCents, currency)}</b></>
            : <>Your share {term.sellerPct}% · TD {term.tdPct}%. Type the amount to see the figures.</>}
        </p>
      )}
      {big && (
        <label className="mt-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span>This is a large amount ({formatMoney(cents, currency)}). I checked it is right.</span>
        </label>
      )}
      <button className="mt-3 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !kind || cents === null || (big && !confirmed)} onClick={create}>
        {busy ? 'Creating…' : 'Create payment link'}
      </button>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {url && (
        <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm" data-testid="new-link">
          <p className="font-medium text-emerald-900">Link ready. Send it to the client; it works for 23 hours.</p>
          <input readOnly className="mt-2 w-full rounded border bg-white px-2 py-1 text-xs" value={url} onFocus={e => e.currentTarget.select()} />
          <button className="mt-2 rounded border bg-white px-3 py-1 text-xs" onClick={() => copy(url)}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
      )}

      {sales.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Links for this lead</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {sales.map(s => {
              const expired = isExpiredLink(s)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span>{kinds.find(k => k.key === s.kind)?.label ?? s.kind} · <b>{formatMoney(s.amount_cents, s.currency)}</b></span>
                  <span className="flex items-center gap-3">
                    <span className={s.status === 'paid' ? 'text-emerald-700' : 'text-slate-500'}>{saleStatusLabel(s)}</span>
                    {s.status === 'link_created' && !expired && s.checkout_url && <button className="text-xs underline" onClick={() => copy(s.checkout_url!)}>Copy link</button>}
                  </span>
                  {s.needs_attention && <p className="w-full text-xs text-amber-800">{s.needs_attention}</p>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
