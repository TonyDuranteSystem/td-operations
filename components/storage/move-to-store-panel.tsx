'use client'

/**
 * "Move this company to the new storage" (job 685467b5, Stage 2 mechanics) — on the company page, owners only,
 * pilot environment only (the API answers allowed:false everywhere else, and this renders nothing).
 * Start → the move runs batch after batch while the page is open (progress shown); a stopped move continues
 * with "Continue". When it is done: the parity report and "Undo the move".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRightLeft, Loader2, CheckCircle2, AlertTriangle, Undo2 } from 'lucide-react'

interface Folder { folder: string; driveFiles: number; moved: number; merged: number; skipped: number; failed: number; checksumChecked: number }
interface Report {
  folders: Folder[]; rowsRepointed: number; rowsCreated: number; fromStorage: number
  skipped: { name: string; where: string; reason: string }[]; failed: { name: string; where: string; reason: string }[]
  needsReview: number; parityOk: boolean; stillReadDrive: string[]
}
interface Run {
  id: string; status: string; startedAt: string; finishedAt: string | null
  counts: { total: number; pending: number; done: number; merged: number; skipped: number; failed: number }
  report: Report | null
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || fallback)
  return j as T
}

export function MoveToStorePanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const router = useRouter()
  const { data } = useQuery<{ allowed: boolean; run: Run | null }>({
    queryKey: ['crm-store-import', accountId],
    queryFn: async () => {
      const r = await fetch(`/api/crm-store/import?account=${encodeURIComponent(accountId)}`)
      if (!r.ok) return { allowed: false, run: null }
      return r.json()
    },
    staleTime: 30_000,
  })
  const [run, setRun] = useState<Run | null>(null)
  const [confirm, setConfirm] = useState<'move' | 'undo' | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => { if (data?.run) setRun(data.run) }, [data?.run])

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['crm-store-owner-for-account', accountId] })
    void qc.invalidateQueries({ queryKey: ['account-files', accountId] })
    void qc.invalidateQueries({ queryKey: ['crm-store-import', accountId] })
    router.refresh()
  }, [qc, router, accountId])

  // one batch after another while the page is open
  const drive = useCallback(async (start: Run) => {
    let r = start
    setStopped(null)
    while (alive.current && r.status === 'moving') {
      try {
        r = await postJson<Run>(`/api/crm-store/import/${r.id}/continue`, {}, 'The move could not continue.')
        if (alive.current) setRun(r)
      } catch (e) {
        if (alive.current) setStopped(e instanceof Error ? e.message : 'The move stopped.')
        return
      }
    }
    if (alive.current && r.status !== 'moving') {
      toast.success(r.status === 'done' ? 'The company is now in the new storage.' : 'The move finished with problems — see the report.')
      refreshAll()
    }
  }, [refreshAll])

  const start = async () => {
    setConfirm(null)
    setBusy(true)
    try {
      const r = await postJson<Run>('/api/crm-store/import', { accountId }, 'The move could not start.')
      setRun(r)
      await drive(r)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The move could not start.')
    } finally { setBusy(false) }
  }
  const undo = async () => {
    if (!run) return
    setConfirm(null)
    setBusy(true)
    try {
      const r = await postJson<Run>(`/api/crm-store/import/${run.id}/undo`, {}, 'The move could not be undone.')
      setRun(r)
      toast.success('Move undone — the CRM records open from Drive again.')
      refreshAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The move could not be undone.')
    } finally { setBusy(false) }
  }

  if (!data?.allowed) return null
  const r = run
  const finished = r && (r.status === 'done' || r.status === 'incomplete')
  const counted = r ? r.counts.done + r.counts.merged + r.counts.skipped + r.counts.failed : 0

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ArrowRightLeft className="h-4 w-4 text-blue-600" />
        <span className="font-medium text-zinc-800">New storage (pilot)</span>
        {r?.status === 'moving' && <span className="inline-flex items-center gap-1 text-xs text-zinc-600"><Loader2 className="h-3.5 w-3.5 animate-spin" />Moving… {counted} of {r.counts.total} files</span>}
        {r?.status === 'done' && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Moved — every file checked</span>}
        {r?.status === 'incomplete' && <span className="inline-flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />Moved with problems</span>}
        <div className="ml-auto flex gap-2">
          {(!r || r.status === 'rolled_back' || r.status === 'failed') && !confirm && (
            <button type="button" disabled={busy} onClick={() => setConfirm('move')} className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50">Move this company to the new storage…</button>
          )}
          {r?.status === 'moving' && stopped && (
            <button type="button" disabled={busy} onClick={() => void drive(r)} className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs hover:bg-zinc-50">Continue</button>
          )}
          {finished && !confirm && (
            <button type="button" disabled={busy} onClick={() => setConfirm('undo')} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs hover:bg-zinc-50"><Undo2 className="h-3.5 w-3.5" />Undo the move…</button>
          )}
        </div>
      </div>

      {r?.status === 'failed' && <p className="mt-2 text-xs text-red-700">The last attempt did not start. Try again, or check that the company&apos;s Drive folder is reachable.</p>}
      {stopped && <p className="mt-2 text-xs text-red-700">{stopped} — nothing is lost; press Continue.</p>}

      {confirm === 'move' && (
        <div className="mt-2 rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-700">
          <p>Every file in this company&apos;s Google Drive folder is copied into the new storage, in the same folders, and its CRM records then open from there. The client sees exactly the same files as before. <strong>Drive is not changed</strong> and stays as the backup. It can be undone.</p>
          <p className="mt-1">Google Docs / Sheets are not moved (they are listed). Keep this page open while it runs.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void start()} className="rounded-md bg-blue-600 px-2.5 py-1 text-white hover:bg-blue-700">Yes, move it</button>
            <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-zinc-300 px-2.5 py-1 hover:bg-zinc-50">Cancel</button>
          </div>
        </div>
      )}
      {confirm === 'undo' && (
        <div className="mt-2 rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-700">
          <p>Every CRM record goes back to its Drive file, the records the move listed are removed and the copied files go to the trash of the new storage. Files added to the new storage since the move are kept.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void undo()} className="rounded-md bg-red-600 px-2.5 py-1 text-white hover:bg-red-700">Yes, undo the move</button>
            <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-zinc-300 px-2.5 py-1 hover:bg-zinc-50">Cancel</button>
          </div>
        </div>
      )}

      {finished && r?.report && (
        <div className="mt-2 space-y-2 text-xs text-zinc-700">
          <p>{r.counts.done} moved{r.counts.merged ? `, ${r.counts.merged} identical copies kept once` : ''}{r.counts.skipped ? `, ${r.counts.skipped} not moved` : ''}{r.counts.failed ? `, ${r.counts.failed} failed` : ''} · {r.report.rowsRepointed} CRM records now open from the new storage{r.report.rowsCreated ? `, ${r.report.rowsCreated} files listed for the first time (hidden)` : ''}{r.report.fromStorage ? ` · ${r.report.fromStorage} kept outside Drive brought in` : ''}{r.report.needsReview ? ` · ${r.report.needsReview} marked Needs review` : ''}.</p>
          <div className="overflow-x-auto">
            <table className="min-w-[28rem] text-left">
              <thead className="text-zinc-500"><tr><th className="pr-3 font-normal">Drive folder</th><th className="pr-3 font-normal">In Drive</th><th className="pr-3 font-normal">Moved</th><th className="pr-3 font-normal">Kept once</th><th className="pr-3 font-normal">Not moved</th><th className="pr-3 font-normal">Failed</th><th className="font-normal">Fingerprint checked</th></tr></thead>
              <tbody>{r.report.folders.map((f) => (
                <tr key={f.folder}><td className="pr-3">{f.folder}</td><td className="pr-3">{f.driveFiles}</td><td className="pr-3">{f.moved}</td><td className="pr-3">{f.merged}</td><td className="pr-3">{f.skipped}</td><td className={`pr-3 ${f.failed ? 'text-red-700' : ''}`}>{f.failed}</td><td>{f.checksumChecked}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {r.report.failed.length > 0 && <div><p className="font-medium text-red-700">Failed</p><ul className="list-disc pl-5">{r.report.failed.slice(0, 50).map((x, i) => <li key={i}>{x.name} ({x.where}) — {x.reason}</li>)}</ul></div>}
          {r.report.skipped.length > 0 && <div><p className="font-medium">Not moved (still in Drive)</p><ul className="list-disc pl-5">{r.report.skipped.slice(0, 50).map((x, i) => <li key={i}>{x.name} ({x.where}) — {x.reason}</li>)}</ul></div>}
          <p className="text-zinc-500">Still read only from Drive for now (to switch before real clients): {r.report.stillReadDrive.join(', ')}.</p>
        </div>
      )}
    </div>
  )
}
