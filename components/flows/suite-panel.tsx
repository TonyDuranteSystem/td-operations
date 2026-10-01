'use client'

import { useState, useEffect, useCallback } from 'react'
import { MapPin, Loader2, CheckCircle2, AlertCircle, Lock } from 'lucide-react'

interface SuitePanelProps {
  serviceDeliveryId: string
}

interface SuiteState {
  account_suite: string | null
  reserved_suite: string | null
  waived: boolean
  waived_reason: string | null
  waived_by: string | null
  satisfied: boolean
}

/**
 * The required "Suite" step. Staff either press "Issue suite" (the next free 3D-NNN — reserved on the case while the
 * company does not exist yet, put on the company when it does) or tick "No suite for this client" with a reason. The
 * case cannot move past this stage until one of the two is done — the server refuses the move (and so does the database).
 * Server errors are shown verbatim (R099).
 */
export function SuitePanel({ serviceDeliveryId }: SuitePanelProps) {
  const [state, setState] = useState<SuiteState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waiveTicked, setWaiveTicked] = useState(false)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/suite`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not read the suite step.')
      setState(data.state as SuiteState)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not read the suite step.')
    } finally {
      setLoaded(true)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  async function act(body: Record<string, unknown>, failMessage: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/suite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || failMessage)
      setState(data.state as SuiteState)
      setWaiveTicked(false)
      setReason('')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : failMessage)
    } finally {
      setBusy(false)
    }
  }

  const suite = state?.account_suite ?? state?.reserved_suite ?? null

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <MapPin className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">Suite (required)</h3>
        {state?.satisfied ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Done
          </span>
        ) : loaded ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-700">
            <AlertCircle className="h-3.5 w-3.5" /> Needed before this case can move on
          </span>
        ) : null}
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          {suite ? (
            <p className="flex items-center gap-2 text-sm text-zinc-800">
              <span className="font-semibold">{suite}</span>
              <Lock className="h-3.5 w-3.5 text-zinc-400" aria-label="Locked" />
              <span className="text-xs text-zinc-500">
                {state?.account_suite ? 'assigned to the company' : 'reserved for this company — goes onto it when it is created'}
              </span>
            </p>
          ) : state?.waived ? (
            <p className="text-sm text-zinc-700">
              <span className="font-medium">No suite for this client</span>
              {state.waived_reason ? <span className="text-zinc-500"> — {state.waived_reason}</span> : null}
              {state.waived_by ? <span className="text-xs text-zinc-400"> ({state.waived_by})</span> : null}
            </p>
          ) : (
            <p className="text-sm text-zinc-500">No suite yet. Issue one, or tick “No suite for this client”.</p>
          )}

          {!suite && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => act({ action: 'issue' }, 'Could not issue the suite.')}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                {state?.waived ? 'Issue a suite instead' : 'Issue suite'}
              </button>
              {state?.waived && (
                <button
                  type="button"
                  onClick={() => act({ action: 'unwaive' }, 'Could not remove the waiver.')}
                  disabled={busy}
                  className="text-xs text-zinc-500 underline hover:text-zinc-700 disabled:opacity-50"
                >
                  Remove the waiver
                </button>
              )}
            </div>
          )}

          {!suite && !state?.waived && (
            <div className="rounded-lg border border-zinc-200 p-2.5">
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={waiveTicked}
                  onChange={e => setWaiveTicked(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300"
                />
                No suite for this client
              </label>
              {waiveTicked && (
                <div className="mt-2 space-y-2">
                  <input
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="Reason (required) — e.g. one-time customer, no lease"
                    className="w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => act({ action: 'waive', reason }, 'Could not record the waiver.')}
                    disabled={busy || reason.trim() === ''}
                    className="rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-200 disabled:opacity-50"
                  >
                    Confirm: no suite for this client
                  </button>
                </div>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
