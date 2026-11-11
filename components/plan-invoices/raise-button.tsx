'use client'

/**
 * "Raise and send" — the button on one row of the Calendar's "Invoices to raise" list (dev job ae3c19db).
 * Two steps on purpose: the button only asks ("Send €1,900 to Mario…? The client will be emailed"); nothing is created or sent until
 * "Yes, raise and send". The server decides the payer, the amount and the double-bill protection (lib/plan-invoices/raise.ts) —
 * this component only names WHICH part. R099: when the server refuses, its own words are shown.
 * A part that is DUE blinks red (gentle pulse; people who turned motion off see a steady red).
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

interface Props {
  offerToken: string
  seq: number
  /** "Part 2 of 2 — €1,900" */
  summary: string
  payerName: string | null
  payerEmail: string | null
  due: boolean
  /** A Draft that only needs sending. */
  draft?: boolean
}

export function RaiseButton({ offerToken, seq, summary, payerName, payerEmail, due, draft = false }: Props) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/admin-actions/raise-plan-part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: offerToken, seq }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'The invoice could not be raised — please try again.')
      toast.success(data.message || 'Invoice raised and sent.')
      setAsking(false)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The invoice could not be raised — please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        data-testid="raise-plan-part"
        className={
          due
            ? 'rounded-md border border-red-700 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 animate-pulse motion-reduce:animate-none'
            : 'rounded-md border px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50'
        }
      >
        {draft ? 'Send invoice' : due ? 'Raise and send' : 'Raise now'}
      </button>
    )
  }

  return (
    <div className="max-w-sm rounded-md border border-zinc-300 bg-white p-3 text-sm shadow-sm" role="group" aria-label="Confirm the invoice">
      <p>
        {draft ? 'Send' : 'Raise and send'} <b>{summary}</b> to <b>{payerName ?? 'the client'}</b>
        {payerEmail ? <> ({payerEmail})</> : null}? The client will be emailed the invoice.
      </p>
      {error && <p className="mt-2 text-red-700" role="alert">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={run} className="rounded-md bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-700 disabled:opacity-60">
          {busy ? 'Sending…' : 'Yes, raise and send'}
        </button>
        <button type="button" disabled={busy} onClick={() => { setAsking(false); setError(null) }} className="rounded-md border px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-60">
          Cancel
        </button>
      </div>
    </div>
  )
}
