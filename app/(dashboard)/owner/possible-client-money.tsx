'use client'

/**
 * "Possibly a client's money" — the triage list.
 *
 * Dev jobs `ae8b8bb1` / `c0a61e44`. Lives at the top of My Finances because that is where the
 * mis-filed money actually sits, and the row's existing "This is for a client →" action is the
 * one that returns it to the Bank Feed. This section adds the two things that were missing:
 * WHY a row looks client-shaped, and the ability to teach the payer so the next one is
 * recognised without anybody looking.
 *
 * ⛔ NOTHING HERE MOVES MONEY. Teaching remembers a payer; returning a transaction to Finance
 * goes through the pre-existing route that deletes the books copy BEFORE restoring the feed.
 *
 * R099: every failed request surfaces the server's own reason. A refusal — "that payer is a
 * payment rail" — is information the person needs, not an error to swallow behind a toast.
 */

import { useCallback, useEffect, useState } from 'react'

interface TaughtFor {
  id: string
  accountId: string | null
  contactId: string | null
  label: string
}

interface SameOwnerCompany {
  accountId: string
  companyName: string
  ownerName: string | null
  alreadyTaught: boolean
}

interface Candidate {
  feedId: string
  transactionDate: string
  amount: number
  currency: string
  payer: string | null
  source: string | null
  reason: string
  detail: string
  suspectedClientName?: string
  suspectedClientId?: string
  filedBy: 'sweep' | 'unknown'
  teachable: boolean
  teachRefusal?: string
  taughtFor: TaughtFor[]
}

interface SearchResult {
  id: string
  label: string
  kind: 'account' | 'contact'
}

const money = (n: number, c: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(n)

export function PossibleClientMoney() {
  const [rows, setRows] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openFor, setOpenFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/finance/payer-learning', { cache: 'no-store' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Could not load the list (HTTP ${res.status}).`)
      }
      const data = await res.json()
      setRows(data.candidates ?? [])
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load the list.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <div className="text-sm text-gray-500 p-4" data-testid="pcm-loading">Checking for client money…</div>

  if (error) {
    return (
      <div className="border border-red-200 bg-red-50 rounded-lg p-4 mb-4 text-sm text-red-800" data-testid="pcm-error">
        {error}{' '}
        <button onClick={() => void load()} className="underline">Try again</button>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="border rounded-lg p-4 mb-4 text-sm text-gray-600" data-testid="pcm-empty">
        Nothing here looks like a client&apos;s money. Anything the system cannot recognise shows up in this
        list first, so it never sits silently in your books.
      </div>
    )
  }

  return (
    <section className="border border-amber-300 bg-amber-50 rounded-lg p-4 mb-6" data-testid="pcm-section">
      <h3 className="font-semibold text-amber-900 mb-1">
        Possibly a client&apos;s money ({rows.length})
      </h3>
      <p className="text-xs text-amber-800 mb-3">
        These are in your own books because nothing identified a client. Send one back to the Bank Feed if it is
        a client&apos;s, and tell the system who the payer is so the next one is recognised on its own.
      </p>

      <ul className="space-y-3">
        {rows.map((row) => (
          <CandidateRow
            key={row.feedId}
            row={row}
            expanded={openFor === row.feedId}
            onToggle={() => setOpenFor(openFor === row.feedId ? null : row.feedId)}
            onChanged={() => void load()}
          />
        ))}
      </ul>
    </section>
  )
}

function CandidateRow({
  row,
  expanded,
  onToggle,
  onChanged,
}: {
  row: Candidate
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [sameOwner, setSameOwner] = useState<SameOwnerCompany[]>([])

  const search = async (q: string) => {
    setQuery(q)
    if (q.trim().length < 2) return setResults([])
    try {
      const res = await fetch(`/api/referral/manual?q=${encodeURIComponent(q)}`)
      if (!res.ok) return
      const data = await res.json()
      setResults(
        (data.results ?? []).map((r: { id: string; name?: string; label?: string; type?: string; kind?: string }) => ({
          id: r.id,
          label: r.name ?? r.label ?? '(unnamed)',
          kind: (r.kind ?? r.type) === 'contact' ? 'contact' : 'account',
        })),
      )
    } catch {
      /* search is a convenience; a failed lookup must not break the row */
    }
  }

  const post = async (body: Record<string, unknown>) => {
    setBusy(true)
    setRowError(null)
    setMsg(null)
    try {
      const res = await fetch('/api/finance/payer-learning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`)
      return data
    } catch (err) {
      setRowError(err instanceof Error && err.message ? err.message : 'That did not work.')
      return null
    } finally {
      setBusy(false)
    }
  }

  const teach = async (subject: { accountId?: string; contactId?: string }) => {
    const data = await post({ action: 'teach', feedId: row.feedId, ...subject })
    if (!data) return
    setSameOwner(data.sameOwner ?? [])
    setMsg(data.created ? 'Payer remembered.' : 'That payer was already remembered for this client.')
    onChanged()
  }

  const forget = async (mappingId: string) => {
    const data = await post({ action: 'remove', mappingId })
    if (!data) return
    setMsg(data.removed ? 'Payer forgotten.' : 'It had already been forgotten.')
    setSameOwner([])
    onChanged()
  }

  const returnToFinance = async () => {
    setBusy(true)
    setRowError(null)
    try {
      const res = await fetch('/api/owner/transactions/to-finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ref: `feed:${row.feedId}` }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || `Could not move it (HTTP ${res.status}).`)
      setMsg('Sent back to the Bank Feed.')
      onChanged()
    } catch (err) {
      setRowError(err instanceof Error && err.message ? err.message : 'Could not move it.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="bg-white border rounded p-3" data-testid={`pcm-row-${row.feedId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {money(row.amount, row.currency)}{' '}
            <span className="text-gray-500 font-normal">· {row.transactionDate}</span>
          </div>
          <div className="text-sm text-gray-800 truncate" title={row.payer ?? ''} data-testid="pcm-payer">
            {row.payer ?? '(no payer name)'}
          </div>
          <p className="text-xs text-gray-600 mt-1" data-testid="pcm-why">{row.detail}</p>

          {row.taughtFor.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 items-center" data-testid="pcm-taught">
              <span className="text-xs text-gray-500">Remembered for:</span>
              {row.taughtFor.map((t) => (
                <span key={t.id} className="text-xs bg-gray-100 border rounded px-1.5 py-0.5">
                  {t.label}
                  <button
                    onClick={() => void forget(t.id)}
                    disabled={busy}
                    className="ml-1 text-gray-500 hover:text-red-700"
                    title="Forget this payer for this client"
                    data-testid={`pcm-forget-${t.id}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 shrink-0">
          <button
            onClick={returnToFinance}
            disabled={busy}
            className="text-xs border rounded px-2 py-1 bg-white hover:bg-gray-50 disabled:opacity-50"
            data-testid="pcm-return"
          >
            {busy ? 'Working…' : 'This is for a client →'}
          </button>
          <button onClick={onToggle} className="text-xs underline text-gray-600" data-testid="pcm-toggle">
            {expanded ? 'Close' : 'Remember payer…'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 border-t pt-3">
          {!row.teachable ? (
            // Cell 7: the refusal is RENDERED, naming the rail — not merely returned.
            <p className="text-xs text-amber-900 bg-amber-100 border border-amber-300 rounded p-2" data-testid="pcm-refusal">
              {row.teachRefusal ?? 'This payer cannot be remembered.'}
            </p>
          ) : (
            <>
              <label className="block text-xs text-gray-600 mb-1">
                Which client does <strong>{row.payer ?? 'this payer'}</strong> pay for?
              </label>
              <input
                value={query}
                onChange={(e) => void search(e.target.value)}
                placeholder="Search a company or a person…"
                className="w-full border rounded px-2 py-1 text-sm"
                data-testid="pcm-search"
              />
              {results.length > 0 && (
                <ul className="mt-1 max-h-40 overflow-auto border rounded divide-y" data-testid="pcm-results">
                  {results.map((r) => (
                    <li key={`${r.kind}-${r.id}`}>
                      <button
                        onClick={() => void teach(r.kind === 'account' ? { accountId: r.id } : { contactId: r.id })}
                        disabled={busy}
                        className="w-full text-left text-sm px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                        data-testid={`pcm-pick-${r.id}`}
                      >
                        {r.label} <span className="text-xs text-gray-500">· {r.kind}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {sameOwner.length > 0 && (
                <div className="mt-3" data-testid="pcm-same-owner">
                  <p className="text-xs text-gray-600 mb-1">
                    Same owner also has — add only if this payer really pays for it too:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {sameOwner.map((c) => (
                      <button
                        key={c.accountId}
                        onClick={() => void teach({ accountId: c.accountId })}
                        disabled={busy || c.alreadyTaught}
                        className="text-xs border rounded px-2 py-0.5 bg-white hover:bg-gray-50 disabled:opacity-60"
                        data-testid={`pcm-extend-${c.accountId}`}
                      >
                        {c.alreadyTaught ? `${c.companyName} — already remembered` : `+ ${c.companyName}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {msg && <p className="text-xs text-green-700 mt-2" data-testid="pcm-msg">{msg}</p>}
          {rowError && <p className="text-xs text-red-700 mt-2" data-testid="pcm-row-error">{rowError}</p>}
        </div>
      )}
    </li>
  )
}
