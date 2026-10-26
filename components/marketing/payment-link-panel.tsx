'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney, isExpiredLink, parseAmountToCents, saleStatusLabel, type SaleRow } from '@/lib/marketing/sales'
import { shortCodeFor } from '@/lib/marketing/short-pay'
import { splitCents } from '@/lib/marketing/commission'
import { useT } from '@/components/marketing/lang-provider'

interface Option { key: string; label: string }
export interface PaymentLinkProps {
  leadId: string
  kinds: Option[]
  currencies: string[]
  confirmAbove: number | null
  /** the split in force for THIS seller, per kind (null = terms not set) */
  splits: Record<string, { sellerPct: number; tdPct: number; basis: string } | null>
  sales: SaleRow[]
  /** the start of the short address (the client-facing domain + /pay/s/) */
  shortBase?: string
}

/** The "Payment link" box on a lead: kind, amount, currency, the split that will be saved, then the link to copy. Every server answer is shown as written. */
export function PaymentLinkPanel({ leadId, kinds, currencies, confirmAbove, splits, sales, shortBase }: PaymentLinkProps) {
  const router = useRouter()
  const t = useT()
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
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Could not create the link. Please try again.'))
      setUrl(d.url)
      setAmount(''); setNote(''); setConfirmed(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not create the link. Please try again.'))
    } finally { setBusy(false) }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { setError(t('Could not copy. Select the link and copy it by hand.')) }
  }

  const input = 'mt-1 w-full rounded-lg border px-3 py-2'
  return (
    <section className="mt-5 rounded-xl border bg-white p-4" aria-label={t('Payment link')}>
      <h2 className="text-sm font-semibold text-slate-600">{t('Payment link')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('Card payment through Stripe. When the client pays, the sale is recorded here by itself.')}</p>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <label className="block"><span className="text-slate-500">{t('What is it for?')}</span>
          <select className={input} value={kind} onChange={e => setKind(e.target.value)}>
            <option value="">{t('Pick…')}</option>{kinds.map(k => <option key={k.key} value={k.key}>{t(k.label)}</option>)}
          </select></label>
        <label className="block"><span className="text-slate-500">{t('Amount')}</span>
          <input className={input} inputMode="decimal" placeholder="1500" value={amount} onChange={e => { setAmount(e.target.value); setConfirmed(false) }} /></label>
        <label className="block"><span className="text-slate-500">{t('Currency')}</span>
          <select className={input} value={currency} onChange={e => setCurrency(e.target.value)}>{currencies.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <label className="mt-3 block text-sm"><span className="text-slate-500">{t('Note (optional, only you and Antonio see it)')}</span>
        <input className={input} maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></label>

      {kind && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm" data-testid="split-preview">
          {term === null ? <>{t('Terms not set for this kind of sale yet. The sale will be recorded and Antonio sets the split afterwards.')}</>
            : term.basis !== 'amount_paid' ? <>{t('The split for this kind is {s}% / {td}% of what is left after card fees; the amounts are set by Antonio after payment.', { s: term.sellerPct, td: term.tdPct })}</>
            : split ? <>{t('Your share {s}% = {a} · TD {td}% = {b}', { s: term.sellerPct, td: term.tdPct, a: formatMoney(split.sellerCents, currency), b: formatMoney(split.tdCents, currency) })}</>
            : <>{t('Your share {s}% · TD {td}%. Type the amount to see the figures.', { s: term.sellerPct, td: term.tdPct })}</>}
        </p>
      )}
      {big && (
        <label className="mt-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span>{t('This is a large amount ({amount}). I checked it is right.', { amount: formatMoney(cents, currency) })}</span>
        </label>
      )}
      <button className="mt-3 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !kind || cents === null || (big && !confirmed)} onClick={create}>
        {busy ? t('Creating…') : t('Create payment link')}
      </button>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {url && (
        <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm" data-testid="new-link">
          <p className="font-medium text-emerald-900">{t('Link ready. Send it to the client; it works for 23 hours.')}</p>
          <input readOnly className="mt-2 w-full rounded border bg-white px-2 py-1 text-xs" value={url} onFocus={e => e.currentTarget.select()} />
          <button className="mt-2 rounded border bg-white px-3 py-1 text-xs" onClick={() => copy(url)}>{copied ? t('Copied') : t('Copy link')}</button>
        </div>
      )}

      {sales.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('Links for this lead')}</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {sales.map(s => {
              const expired = isExpiredLink(s)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span>{t(kinds.find(k => k.key === s.kind)?.label ?? s.kind)} · <b>{formatMoney(s.amount_cents, s.currency)}</b></span>
                  <span className="flex items-center gap-3">
                    <span className={s.status === 'paid' ? 'text-emerald-700' : 'text-slate-500'}>{t(saleStatusLabel(s))}</span>
                    {s.status === 'link_created' && !expired && s.checkout_url && <button className="text-xs underline" onClick={() => copy(shortBase && shortCodeFor(s.id) ? `${shortBase}${shortCodeFor(s.id)}` : s.checkout_url!)}>{t('Copy link')}</button>}
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
