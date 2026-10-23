'use client'

/**
 * Payments to confirm — the buttons on one waiting payment (Calendar → Payments to confirm).
 * Two steps on purpose: a button only PICKS what the payment was and says in plain words what will happen; nothing is written
 * until "Confirm". The server re-reads the money from the saved Stripe event, so nothing here can change an amount (R099: the
 * server's own words are shown when it refuses).
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Resolution = 'paid_call' | 'paid_call_already_deducted' | 'recorded_elsewhere'

interface Props {
  sessionId: string
  amountText: string
  /** Leads that share the payer's email. The first is pre-selected; "no lead" is always possible. */
  leads: Array<{ id: string; name: string; status: string }>
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
    key: 'recorded_elsewhere',
    label: 'Already recorded / not a client payment',
    explain: () => 'Writes nothing to the books. The payment just leaves this list, and your note explains why.',
  },
]

export function ConfirmActions({ sessionId, amountText, leads }: Props) {
  const router = useRouter()
  const [pick, setPick] = useState<Resolution | null>(null)
  const [leadId, setLeadId] = useState<string>(leads[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!pick || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/admin-actions/incoming-payments/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, resolution: pick, lead_id: leadId || undefined, note: note.trim() || undefined }),
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
      {leads.length > 0 && pick !== 'recorded_elsewhere' && (
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
            onClick={() => { setPick(c.key); setError(null) }}
            aria-pressed={pick === c.key}
            className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${pick === c.key ? 'border-blue-600 bg-blue-50 text-blue-800' : 'text-zinc-700 hover:bg-zinc-50'}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {choice && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <p>{choice.explain(amountText)}</p>
          {pick === 'recorded_elsewhere' && (
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={1000}
              placeholder="Where is it recorded, or what was it?"
              aria-label="Note"
              className="mt-2 block w-full rounded-md border bg-white px-2 py-1 text-sm text-foreground"
            />
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={busy || (pick === 'recorded_elsewhere' && note.trim().length < 3)}
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
