'use client'

/**
 * Payments to confirm — the buttons on one waiting payment (Calendar → Payments to confirm).
 * Two steps on purpose: a button only PICKS what the payment was and says in plain words what will happen; nothing is written
 * until "Confirm". The server re-reads the money from the saved Stripe event, so nothing here can change an amount (R099: the
 * server's own words are shown when it refuses).
 *
 * Choices: paid call (2 ways), marketing sale (pick the marketing lead + the kind of sale), an invoice that was paid (pick it from
 * the payer's open invoices), or already recorded / not a client payment (a note).
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { OpenInvoice } from '@/lib/incoming-payments/classify'

type Resolution = 'paid_call' | 'paid_call_already_deducted' | 'recorded_elsewhere' | 'marketing_sale' | 'invoice_paid'

interface MarketingLeadChoice {
  id: string
  name: string
  email: string | null
  teamId: string | null
  kinds: Array<{ key: string; label: string }>
}

interface Props {
  sessionId: string
  amount: number
  currency: 'EUR' | 'USD'
  amountText: string
  /** Leads that share the payer's email. The first is pre-selected; "no lead" is always possible. */
  leads: Array<{ id: string; name: string; status: string }>
  /** The payer's open invoices (for "An invoice was paid"). */
  invoices: OpenInvoice[]
  /** What to type in the marketing-lead search first (the payer's name or email). */
  searchSeed: string
}

const CHOICES: Array<{ key: Resolution; label: string; explain: (amount: string) => string }> = [
  {
    key: 'paid_call',
    label: 'Paid call',
    explain: a => `Records ${a} as a paid strategy call and keeps ${a} as a credit that is deducted from the offer this person signs. The lead is not converted.`,
  },
  {
    key: 'paid_call_already_deducted',
    label: 'Paid call — already deducted by hand',
    explain: a => `Records ${a} as a paid strategy call, but leaves no credit: you already took ${a} off the offer yourself, so the system must not deduct it again.`,
  },
  {
    key: 'marketing_sale',
    label: 'Marketing sale',
    explain: a => `Records ${a} in TD Marketing's own sales list, under marketing's rules (the split in force on the day it was paid). It touches no client record and creates no client payment.`,
  },
  {
    key: 'invoice_paid',
    label: 'An invoice was paid',
    explain: a => `Marks the invoice you pick as paid with ${a}, exactly like any other payment (a smaller amount is a part payment). It never applies more than the invoice still owes.`,
  },
  {
    key: 'recorded_elsewhere',
    label: 'Already recorded / not a client payment',
    explain: () => 'Writes nothing to the books. The payment just leaves this list, and your note explains why.',
  },
]

function money(n: number, cur: string) {
  return `${cur === 'EUR' ? '€' : '$'}${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

export function ConfirmActions({ sessionId, amount, currency, amountText, leads, invoices, searchSeed }: Props) {
  const router = useRouter()
  const [pick, setPick] = useState<Resolution | null>(null)
  const [leadId, setLeadId] = useState<string>(leads[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // marketing sale
  const [q, setQ] = useState(searchSeed)
  const [searching, setSearching] = useState(false)
  const [found, setFound] = useState<MarketingLeadChoice[] | null>(null)
  const [mktAvailable, setMktAvailable] = useState(true)
  const [mktLead, setMktLead] = useState<MarketingLeadChoice | null>(null)
  const [kind, setKind] = useState('')

  // invoice
  const [invoiceId, setInvoiceId] = useState('')

  async function search(text: string) {
    setSearching(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/admin-actions/incoming-payments/marketing-leads?q=${encodeURIComponent(text)}`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not search the marketing leads — please try again.')
      setMktAvailable(d.available !== false)
      setFound((d.leads ?? []) as MarketingLeadChoice[])
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not search the marketing leads — please try again.')
    } finally {
      setSearching(false)
    }
  }

  function choose(key: Resolution) {
    setPick(key)
    setError(null)
    if (key === 'marketing_sale' && found === null && searchSeed.trim().length >= 2) void search(searchSeed)
  }

  function usable(inv: OpenInvoice): string | null {
    if (inv.currency !== currency) return `in ${inv.currency}, this payment is ${currency}`
    if (amount > inv.amountDue + 0.005) return `owes only ${money(inv.amountDue, inv.currency)}, less than this payment`
    return null
  }

  const needsMore =
    (pick === 'recorded_elsewhere' && note.trim().length < 3) ||
    (pick === 'marketing_sale' && (!mktLead || !mktLead.teamId || !kind)) ||
    (pick === 'invoice_paid' && !invoiceId)

  async function confirm() {
    if (!pick || busy || needsMore) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/admin-actions/incoming-payments/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          resolution: pick,
          lead_id: pick === 'paid_call' || pick === 'paid_call_already_deducted' ? leadId || undefined : undefined,
          note: note.trim() || undefined,
          marketing_lead_id: pick === 'marketing_sale' ? mktLead?.id : undefined,
          sale_kind: pick === 'marketing_sale' ? kind : undefined,
          invoice_payment_id: pick === 'invoice_paid' ? invoiceId : undefined,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not confirm this payment — please try again.')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not confirm this payment — please try again.')
      setBusy(false)
    }
  }

  const choice = CHOICES.find(c => c.key === pick)

  return (
    <div className="space-y-2">
      {leads.length > 0 && (pick === 'paid_call' || pick === 'paid_call_already_deducted' || pick === null) && (
        <label className="block text-xs text-zinc-600">
          For which lead
          <select
            value={leadId}
            onChange={e => setLeadId(e.target.value)}
            disabled={busy}
            className="mt-0.5 block w-full rounded-md border px-2 py-1 text-sm text-foreground"
            aria-label="Lead this payment belongs to"
          >
            {leads.map(l => (
              <option key={l.id} value={l.id}>{l.name || 'Unnamed lead'} ({l.status || 'no status'})</option>
            ))}
            <option value="">No lead (use the payer&apos;s email)</option>
          </select>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        {CHOICES.map(c => (
          <button
            key={c.key}
            type="button"
            disabled={busy}
            onClick={() => choose(c.key)}
            aria-pressed={pick === c.key}
            className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${pick === c.key ? 'border-blue-600 bg-blue-50 text-blue-800' : 'text-zinc-700 hover:bg-zinc-50'}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {choice && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 space-y-2">
          <p>{choice.explain(amountText)}</p>

          {pick === 'marketing_sale' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void search(q) } }}
                  placeholder="Search the marketing lead by name or email"
                  aria-label="Search marketing leads"
                  className="block w-full rounded-md border bg-white px-2 py-1 text-sm text-foreground"
                />
                <button type="button" onClick={() => void search(q)} disabled={searching || q.trim().length < 2} className="rounded-md border bg-white px-3 py-1 text-sm font-semibold text-blue-800 disabled:opacity-50">
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </div>
              {!mktAvailable && <p className="text-xs text-amber-900">This database has no TD Marketing data, so no marketing lead can be picked here.</p>}
              {found && found.length === 0 && mktAvailable && (
                <p className="text-xs text-amber-900">No marketing lead matches. If this person is not a marketing lead yet, add them in TD Marketing first, then come back.</p>
              )}
              {found && found.length > 0 && (
                <ul className="space-y-1" aria-label="Marketing leads found">
                  {found.map(l => (
                    <li key={l.id}>
                      <label className="flex items-start gap-2 rounded-md bg-white px-2 py-1 text-foreground">
                        <input
                          type="radio"
                          name={`mkt-${sessionId}`}
                          checked={mktLead?.id === l.id}
                          onChange={() => { setMktLead(l); setKind(l.kinds[0]?.key ?? '') }}
                          className="mt-1"
                        />
                        <span>
                          {l.name || 'Unnamed'} <span className="text-xs text-zinc-500">{l.email ?? 'no email'}</span>
                          {!l.teamId && <span className="ml-1 text-xs text-amber-800">— not on a team yet: assign it to a team in TD Marketing first</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {mktLead?.teamId && (
                <label className="block text-xs text-zinc-700">
                  Kind of sale
                  <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind of sale" className="mt-0.5 block w-full rounded-md border bg-white px-2 py-1 text-sm text-foreground">
                    {mktLead.kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}

          {pick === 'invoice_paid' && (
            invoices.length === 0 ? (
              <p className="text-xs text-amber-900">No open invoice found for this payer (by the payer&apos;s email). If it paid something else, use &quot;Already recorded / not a client payment&quot; and record it by hand.</p>
            ) : (
              <ul className="space-y-1" aria-label="Open invoices">
                {invoices.map(inv => {
                  const why = usable(inv)
                  return (
                    <li key={inv.paymentId}>
                      <label className={`flex items-start gap-2 rounded-md bg-white px-2 py-1 text-foreground ${why ? 'opacity-60' : ''}`}>
                        <input type="radio" name={`inv-${sessionId}`} disabled={!!why} checked={invoiceId === inv.paymentId} onChange={() => setInvoiceId(inv.paymentId)} className="mt-1" />
                        <span>
                          <b>{inv.invoiceNumber}</b> · {money(inv.amountDue, inv.currency)} still owed · {inv.status}{inv.dueDate ? ` · due ${inv.dueDate}` : ''}
                          {inv.description && <span className="block text-xs text-zinc-500">{inv.description}</span>}
                          {why && <span className="block text-xs text-amber-800">Cannot be used: {why}.</span>}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )
          )}

          {pick === 'recorded_elsewhere' && (
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={1000}
              placeholder="Where is it recorded, or what was it?"
              aria-label="Note"
              className="block w-full rounded-md border bg-white px-2 py-1 text-sm text-foreground"
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={busy || needsMore}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button type="button" onClick={() => setPick(null)} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</p>
      )}
    </div>
  )
}
