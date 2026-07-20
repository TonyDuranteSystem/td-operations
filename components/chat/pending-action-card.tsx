'use client'

/**
 * The confirmation card: what the assistant wants to do, in the exact values it will do
 * it with, and one click to let it.
 *
 * Antonio, 2026-07-20 — the behaviour this replaces: the assistant works out that Banking
 * should move to Documents Received, that a note should be added and a follow-up set for
 * Thursday, then writes all three out in prose and the staff member does them by hand.
 * The card shows the same three things with their real values and does them on one click.
 *
 * WHAT IS SHOWN IS WHAT WILL RUN. Every field here comes from the frozen queue row, not
 * from the reply text. The assistant cannot describe one action and have another execute,
 * because the description is not what the button submits — only the id is. This mirrors
 * the download button and the prepared-send card, both of which had to stop trusting the
 * model's own account of what it did.
 *
 * ONE CLICK, ONE RUN. The button disables on press and the server does an atomic
 * compare-and-set, so a double-click cannot create two invoices. Belt and braces on
 * purpose: the disable can be lost to a re-render, the database check cannot.
 */

import { useState } from 'react'
import { Check, X, Loader2, AlertCircle } from 'lucide-react'

export interface PendingActionCardData {
  id: string
  tool: string
  params: Record<string, unknown>
  title: string
}

type Outcome = 'idle' | 'working' | 'done' | 'discarded' | 'error'

/** Render one frozen value readably without hiding what it actually is. */
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // Objects/arrays are shown as JSON rather than "[object Object]": this is the payload
  // being approved, so an unreadable field would make the confirmation meaningless.
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Turn a params key into a label without inventing meaning it doesn't have. */
function labelFor(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export function PendingActionCard({
  action,
  onSettled,
}: {
  action: PendingActionCardData
  onSettled?: (id: string, outcome: 'done' | 'discarded') => void
}) {
  const [state, setState] = useState<Outcome>('idle')
  const [error, setError] = useState<string | null>(null)

  const busy = state === 'working'
  const settled = state === 'done' || state === 'discarded'

  async function decide(choice: 'confirm' | 'discard') {
    if (busy || settled) return
    setState('working')
    setError(null)
    try {
      const res = await fetch('/api/worker/confirm-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ONLY the id travels. The payload stays server-side, so nothing between here
        // and the database can alter what was approved.
        body: JSON.stringify({ id: action.id, action: choice }),
      })
      if (!res.ok) {
        // R099 — surface the server's real reason. "Failed" alone sends the staff member
        // to ask someone; "already confirmed" or "that service no longer exists" tells
        // them what to do next.
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'The action could not be completed — please try again.')
      }
      const outcome = choice === 'confirm' ? 'done' : 'discarded'
      setState(outcome)
      onSettled?.(action.id, outcome)
    } catch (err) {
      setState('error')
      setError(err instanceof Error && err.message ? err.message : 'The action could not be completed.')
    }
  }

  const entries = Object.entries(action.params ?? {})

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-left">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-900">{action.title}</p>
          {/* Nothing has happened yet — say so where the eye lands, because the whole
              risk of this card is someone assuming it already ran. */}
          <p className="text-[11px] text-amber-700">Waiting for your confirmation — nothing has run yet.</p>
        </div>
      </div>

      {entries.length > 0 && (
        <dl className="mt-2 space-y-1 border-t border-amber-200 pt-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <dt className="shrink-0 font-medium text-amber-800">{labelFor(k)}</dt>
              <dd className="min-w-0 break-words text-amber-900">{renderValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {state === 'done' && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-emerald-700">
          <Check className="h-3.5 w-3.5" /> Done.
        </p>
      )}
      {state === 'discarded' && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
          <X className="h-3.5 w-3.5" /> Discarded — nothing ran.
        </p>
      )}
      {state === 'error' && error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] font-medium text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {!settled && (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={() => decide('confirm')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {busy ? 'Running…' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => decide('discard')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <X className="h-3.5 w-3.5" />
            Discard
          </button>
        </div>
      )}
    </div>
  )
}
