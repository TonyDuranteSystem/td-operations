'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, PenLine, AlertTriangle } from 'lucide-react'
import { displayNameFor } from '@/lib/flows/name-loop-policy'

interface ApplyState {
  currentName: string | null
  filedName: string | null
  hasStampedDocument: boolean
  blockers: string[]
  applied: { oldName: string | null; newName: string | null } | null
}

interface DoneInfo {
  oldName?: string
  newName?: string
  storage?: { status?: string; reason?: string } | null
}

/**
 * Company Change Name, step "Update our records": the one button that applies the new name the state approved. It renames the
 * company and moves the old storage folders into "Previous names" in ONE step (lib/operations/change-name-apply.ts). Staff types
 * the name exactly as printed on the state's stamped document; the server refuses until a name is filed and the document is in.
 */
export function ApplyNamePanel({ serviceDeliveryId }: { serviceDeliveryId: string }) {
  const router = useRouter()
  const [state, setState] = useState<ApplyState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [mismatchOk, setMismatchOk] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<DoneInfo | null>(null)
  const [undoAsking, setUndoAsking] = useState(false)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undone, setUndone] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/apply-new-name`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'Could not load this step.')
      const s = data.state as ApplyState
      setState(s)
      setTyped((prev) => prev || (s.filedName ? displayNameFor(s.filedName) : ''))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load this step.')
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    void load()
  }, [load])

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/apply-new-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: typed, confirm_mismatch: mismatchOk }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) {
        if (data?.mismatch) setNeedsConfirm(true)
        throw new Error(data?.error || 'The new name could not be applied.')
      }
      setDone(data.result as DoneInfo)
      setAsking(false)
      await load()
      router.refresh() // the company name shown elsewhere on the page changed
    } catch (err) {
      setAsking(false)
      setError(err instanceof Error && err.message ? err.message : 'The new name could not be applied.')
    } finally {
      setBusy(false)
    }
  }

  async function undo() {
    setUndoBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/undo-new-name`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'The name change could not be undone.')
      setUndone((data.result?.restoredName as string | undefined) ?? '')
      setUndoAsking(false)
      setDone(null)
      setTyped('')
      await load()
      router.refresh() // the company name shown elsewhere on the page changed back
    } catch (err) {
      setUndoAsking(false)
      setError(err instanceof Error && err.message ? err.message : 'The name change could not be undone.')
    } finally {
      setUndoBusy(false)
    }
  }

  const applied = state?.applied ?? (done ? { oldName: done.oldName ?? null, newName: done.newName ?? null } : null)
  const blocked = (state?.blockers?.length ?? 0) > 0
  const canApply = !!state && !blocked && typed.trim().length > 0 && (!needsConfirm || mismatchOk)

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        <PenLine className="h-4 w-4 text-zinc-500" /> Apply the new name
      </h3>

      {!state && !error && <p className="mt-2 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}

      {applied && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4" /> The company was renamed{applied.oldName && applied.newName ? ` from “${applied.oldName}” to “${applied.newName}”` : ''}.</p>
          <p className="mt-1 text-emerald-800">The old folders were moved into “Previous names”; the old name is kept on the company page. Nothing else is renamed for you:</p>
          <ul className="mt-1 list-disc pl-5 text-emerald-800">
            <li>the IRS, the banks and the state registries still have the old name (separate services);</li>
            <li>the next step asks the client for the new Operating Agreement, which will carry the new name.</li>
          </ul>
          {!undoAsking ? (
            <button type="button" onClick={() => setUndoAsking(true)} disabled={undoBusy} className="mt-3 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100">
              Undo name change
            </button>
          ) : (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
              <p>This puts the old name and the old folders back. It only works while the new folders are still empty. Continue?</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={undoBusy} onClick={() => void undo()} className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:bg-zinc-300">
                  {undoBusy ? 'Undoing…' : 'Yes, undo it'}
                </button>
                <button type="button" disabled={undoBusy} onClick={() => setUndoAsking(false)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {undone !== null && !applied && (
        <p className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
          The name change was undone{undone ? `: the company is “${undone}” again` : ''}, and the old folders are back. You can apply the name again below.
        </p>
      )}

      {state && !applied && (
        <>
          <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-zinc-500">Name today</dt><dd className="font-medium text-zinc-900">{state.currentName ?? '—'}</dd></div>
            <div><dt className="text-xs text-zinc-500">Name we filed</dt><dd className="font-medium text-zinc-900">{state.filedName ? displayNameFor(state.filedName) : '—'}</dd></div>
          </dl>

          {blocked && (
            <ul className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {state.blockers.map((b) => <li key={b} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {b}</li>)}
            </ul>
          )}

          <label htmlFor={`apply-name-${serviceDeliveryId}`} className="mt-3 block text-xs font-medium text-zinc-600">
            New name, exactly as printed on the state&apos;s document
          </label>
          <input
            id={`apply-name-${serviceDeliveryId}`}
            value={typed}
            onChange={(e) => { setTyped(e.target.value); setNeedsConfirm(false); setMismatchOk(false); setError(null) }}
            disabled={blocked || busy}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-100"
          />

          {needsConfirm && (
            <label className="mt-2 flex items-start gap-2 text-sm text-amber-900">
              <input type="checkbox" checked={mismatchOk} onChange={(e) => setMismatchOk(e.target.checked)} className="mt-1" />
              <span>The state&apos;s document prints exactly this name, even though it is not the name we filed.</span>
            </label>
          )}

          {!asking ? (
            <button
              type="button"
              disabled={!canApply || busy}
              onClick={() => setAsking(true)}
              className="mt-3 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              Apply new name
            </button>
          ) : (
            <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <p>This renames the company to <b>“{typed.trim()}”</b> and moves its old folders into “Previous names”. Continue?</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void apply()} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-zinc-300">
                  {busy ? 'Applying…' : 'Yes, apply it'}
                </button>
                <button type="button" disabled={busy} onClick={() => setAsking(false)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm">Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
