'use client'

/**
 * Lead page → "Create payment link": a Stripe card link with a FREE amount, currency and description (incoming-payments Phase 2).
 * The link says what it is for, so the system never has to guess when it is paid:
 *   Paid call  -> recorded by itself when paid (revenue + a credit deducted from the next offer); the lead is not converted.
 *   Other      -> waits in Calendar → Payments to confirm, where you say what it was.
 * Nothing is sent to the client: you copy the link and send it yourself. R099: the server's own words are shown when it refuses.
 */

import { useState } from 'react'
import { Link2 } from 'lucide-react'

const CONFIRM_ABOVE = 2000 // mirrors lib/incoming-payments/payment-link.ts; the server enforces it too

interface Props {
  leadId: string
  leadEmail?: string | null
  leadLanguage?: string | null
}

type Purpose = 'paid_call' | 'other'

export function CreatePaymentLink({ leadId, leadEmail, leadLanguage }: Props) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<'EUR' | 'USD'>(/^it/i.test(leadLanguage ?? '') ? 'EUR' : 'USD')
  const [description, setDescription] = useState('Strategic call')
  const [purpose, setPurpose] = useState<Purpose>('paid_call')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ url: string; expiresAt: string | null; purpose: Purpose; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const amountNum = Number(amount.replace(',', '.'))
  const large = Number.isFinite(amountNum) && amountNum > CONFIRM_ABOVE

  async function create() {
    if (busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/crm/admin-actions/payment-links/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, amount, currency, description, purpose, confirmed }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create the link — please try again.')
      setResult({ url: d.url, expiresAt: d.expiresAt ?? null, purpose, text: `${currency === 'EUR' ? '€' : '$'}${amount} — ${description}` })
      setCopied(false)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not create the link — please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.url)
      setCopied(true)
    } catch {
      setError('Your browser would not copy it: select the link above and copy it by hand.')
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 transition-colors"
      >
        <Link2 className="h-4 w-4" />
        Create payment link
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-lg border p-4 space-y-3 max-w-xl" aria-label="Create payment link">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Create payment link</p>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:underline">Close</button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="col-span-2 text-xs text-zinc-600">
          Amount
          <input
            value={amount}
            onChange={e => { setAmount(e.target.value); setConfirmed(false) }}
            inputMode="decimal"
            placeholder="e.g. 397"
            aria-label="Amount"
            className="mt-0.5 block w-full rounded-md border px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="text-xs text-zinc-600">
          Currency
          <select
            value={currency}
            onChange={e => setCurrency(e.target.value as 'EUR' | 'USD')}
            aria-label="Currency"
            className="mt-0.5 block w-full rounded-md border px-2 py-1.5 text-sm text-foreground"
          >
            <option value="EUR">EUR €</option>
            <option value="USD">USD $</option>
          </select>
        </label>
      </div>

      <label className="block text-xs text-zinc-600">
        What the client sees on the payment page
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={80}
          aria-label="Description"
          className="mt-0.5 block w-full rounded-md border px-2 py-1.5 text-sm text-foreground"
        />
      </label>

      <fieldset className="space-y-1 text-sm">
        <legend className="text-xs text-zinc-600">What is this payment for?</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="purpose" checked={purpose === 'paid_call'} onChange={() => setPurpose('paid_call')} className="mt-1" />
          <span><b>Paid call</b> — recorded by itself when paid, as a paid strategy call plus a credit deducted from the next offer. The lead is not converted.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="purpose" checked={purpose === 'other'} onChange={() => setPurpose('other')} className="mt-1" />
          <span><b>Something else</b> — nothing is recorded; when paid it waits in Calendar → Payments to confirm and you say what it was.</span>
        </label>
      </fieldset>

      {!leadEmail && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          This lead has no email, so the payment page will ask the client for one. A paid call needs an email to be recorded.
        </p>
      )}

      {large && (
        <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-0.5" />
          <span>Yes, {currency === 'EUR' ? '€' : '$'}{amount} is the right amount (it is more than {CONFIRM_ABOVE.toLocaleString('en-US')}).</span>
        </label>
      )}

      <button
        type="button"
        onClick={create}
        disabled={busy || amount.trim() === '' || (large && !confirmed)}
        className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create link'}
      </button>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</p>}

      {result && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900 space-y-2">
          <p><b>Link ready</b> — {result.text}. Nothing was sent: copy it and send it yourself.</p>
          <input readOnly value={result.url} onFocus={e => e.currentTarget.select()} aria-label="Payment link" className="block w-full rounded-md border bg-white px-2 py-1.5 text-xs text-foreground" />
          <div className="flex items-center gap-3">
            <button type="button" onClick={copy} className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-800">
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <span className="text-xs">
              {result.expiresAt ? `Valid until ${new Date(result.expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} (23 hours). ` : ''}
              {result.purpose === 'paid_call' ? 'When paid, it is recorded as a paid call by itself.' : 'When paid, it appears in Payments to confirm.'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
