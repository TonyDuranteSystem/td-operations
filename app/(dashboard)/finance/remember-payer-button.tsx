'use client'

/**
 * "Remember this payer" — the teach control on the NORMAL manual-match path.
 *
 * Dev jobs `ae8b8bb1` / `c0a61e44`. Antonio has been matching payments by hand for months, and
 * every one of those clicks already contains the answer the deposit router otherwise has to guess
 * at. Putting the control here — rather than only on the triage screen — turns a handful of
 * training examples into one per bank-feed session, indefinitely.
 *
 * ⛔ IT NEVER MOVES MONEY, and it never chooses a client. The server resolves the client from the
 * invoice the transaction is already matched to; this button sends a transaction id and nothing
 * more. A refusal (a payment rail, money leaving the account) is RENDERED here rather than
 * swallowed, because a person who clicked deserves to know why nothing was remembered.
 */

import { useState } from 'react'

interface Props {
  feedId: string
  /** The bank's own payer text, shown so staff recognise what they are teaching. */
  payerName: string | null
  /**
   * Feed status. An OUTGOING transaction offers no teach action at all — there is no client
   * payer to remember when money is leaving, and offering it would invite a wrong mapping.
   */
  status: string
  /** True once the transaction is matched to an invoice — the client comes from that invoice. */
  matched: boolean
}

export function RememberPayerButton({ feedId, payerName, status, matched }: Props) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  // Cell 9 of the gate: money leaving the account offers NO teach action in the UI.
  if (status === 'outgoing') return null
  // Nothing to learn from until the transaction is tied to an invoice.
  if (!matched) return null

  const remember = async () => {
    setState('busy')
    setMessage(null)
    try {
      const res = await fetch('/api/finance/payer-learning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'teach_from_match', feedId }),
      })
      const data = await res.json().catch(() => ({}))
      // R099: surface the server's own reason, never a generic failure.
      if (!res.ok) throw new Error(data.error || `Could not remember this payer (HTTP ${res.status}).`)
      setState('done')
      setMessage(
        data.created
          ? 'Remembered — the next payment from this sender will be recognised.'
          : 'Already remembered for this client.',
      )
    } catch (err) {
      setState('error')
      setMessage(err instanceof Error && err.message ? err.message : 'Could not remember this payer.')
    }
  }

  if (state === 'done') {
    return (
      <span className="text-[10px] text-green-700 shrink-0" title={message ?? ''} data-testid="remember-payer-done">
        ✓ payer remembered
      </span>
    )
  }

  return (
    <span className="shrink-0 flex items-center gap-1">
      <button
        onClick={() => void remember()}
        disabled={state === 'busy'}
        className="text-[10px] border rounded px-1.5 py-0.5 bg-white hover:bg-zinc-50 disabled:opacity-50"
        title={
          payerName
            ? `Remember that "${payerName}" pays for this client, so the next payment is recognised automatically`
            : 'Remember this payer for this client'
        }
        data-testid="remember-payer"
      >
        {state === 'busy' ? 'Saving…' : 'Remember payer'}
      </button>
      {state === 'error' && message && (
        <span className="text-[10px] text-red-700 max-w-xs" data-testid="remember-payer-error">
          {message}
        </span>
      )}
    </span>
  )
}
