'use client'

/**
 * What "Check contents" found in a copy (job 685467b5, File Understanding): per file, green/red with the reasons in
 * plain words, what the AI thinks it is (type + a proposed name), and look-alike files. NOTHING here acts by itself:
 * "Use this type" opens the ordinary Set type box (with all its questions), "Use this name" renames, "Remove this
 * copy" trashes a chosen twin (restorable). Every choice is recorded — and teaches the system — through /understand/decision.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { SetTypeDialog } from './set-type-dialog'

export interface UnderstandRow {
  fileId: string; analysisId: string | null; name: string; folder: string | null
  currentTypeSlug: string | null; currentType: string | null; kind: string | null; status: string
  verdict: 'green' | 'red' | null; reasons: string[]; reasonTexts: string[]
  aiTypeSlug: string | null; aiType: string | null; aiName: string | null; aiReason: string | null
  identity: boolean; words: number; problem: string | null
  twin: { fileId: string; name: string; folder: string | null; kind: string; note: string; differences: Array<{ onlyInA: string[]; onlyInB: string[] }> } | null
}
export interface UnderstandReportData { runId: string; rows: UnderstandRow[]; unfinished: number; aiOn: boolean; spentTodayUsd: number; capUsd: number }
/** kept for the dialog's import */
export type ContentReportData = UnderstandReportData

async function post(url: string, body: unknown, fallback: string): Promise<unknown> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || fallback)
  return j
}

export function ContentsReport({ title, data, onClose, onChanged }: { title: string; data: UnderstandReportData; onClose: () => void; onChanged: () => void }) {
  const [typeFor, setTypeFor] = useState<UnderstandRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const green = data.rows.filter((r) => r.verdict === 'green').length

  const record = async (row: UnderstandRow, action: 'applied' | 'dismissed') => {
    if (!row.analysisId) return
    await post('/api/crm-store/understand/decision', { analysisId: row.analysisId, action }, 'The decision could not be saved.')
  }
  const applyName = async (row: UnderstandRow) => {
    if (!row.aiName) return
    setBusy(row.fileId + 'n')
    try {
      const ext = /\.[A-Za-z0-9]{1,5}$/.exec(row.name)?.[0] ?? ''
      await post(`/api/crm-store/browse/file/${row.fileId}/rename`, { name: row.aiName + ext }, 'The file could not be renamed.')
      toast.success('Renamed'); onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'The file could not be renamed.') } finally { setBusy(null) }
  }
  const dismiss = async (row: UnderstandRow) => {
    setBusy(row.fileId + 'd')
    try { await record(row, 'dismissed'); toast.success('Dismissed — noted'); onChanged() } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save.') } finally { setBusy(null) }
  }
  const removeCopy = async (row: UnderstandRow) => {
    if (!row.twin) return
    const same = row.twin.kind === 'same_bytes' ? 'identical to' : 'has the same words as (it can still LOOK different — e.g. one may be signed)'
    if (!window.confirm(`Remove "${row.name}" (${row.folder ?? '—'})? It is ${same} "${row.twin.name}" (${row.twin.folder ?? '—'}), which stays. The removed copy goes to the storage trash and can be restored.`)) return
    setBusy(row.fileId + 'r')
    try {
      await post(`/api/crm-store/browse/file/${row.fileId}/delete`, {}, 'The copy could not be removed.')
      toast.success('Copy removed — it is in the trash'); onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'The copy could not be removed.') } finally { setBusy(null) }
  }

  return (
    <div className="mt-2 max-h-96 overflow-y-auto rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-700" data-testid="contents-report">
      <div className="flex items-center">
        <p className="font-medium text-zinc-800">What the system understood — {title} · {green} green, {data.rows.length - green} red{data.unfinished ? ` · ${data.unfinished} not done yet (press Check contents again)` : ''}</p>
        <button type="button" onClick={onClose} className="ml-auto rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50">Close</button>
      </div>
      {!data.aiOn && <p className="mt-1 rounded bg-amber-50 p-1.5 text-amber-800">The AI is switched off here — files were only read, not judged.</p>}
      <p className="mt-1 text-zinc-500">AI spend today ${data.spentTodayUsd.toFixed(2)} of ${data.capUsd.toFixed(2)}. Red = a person decides. Nothing here changes a file until you press a button.</p>
      <ul className="mt-2 space-y-1.5">
        {data.rows.map((r) => (
          <li key={r.fileId} className={`rounded border p-1.5 ${r.verdict === 'green' ? 'border-emerald-200' : 'border-red-200'}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              {r.verdict === 'green' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-red-600" />}
              <span className="font-medium">{r.name}</span><span className="text-zinc-500">in {r.folder ?? '—'}{r.kind ? ` · ${r.kind}` : ''}</span>
            </div>
            <div>Now: <strong>{r.currentType ?? 'no type'}</strong> · The AI says: <strong>{r.aiType ?? 'unknown'}</strong>{r.aiName ? <> · name: “{r.aiName}”</> : null}</div>
            {r.aiReason && <div className="text-zinc-500">Why: {r.aiReason}</div>}
            {r.problem && <div className="text-amber-700">{r.problem}</div>}
            {r.reasonTexts.length > 0 && <div className="text-red-700">Red because: {r.reasonTexts.join(' · ')}</div>}
            {r.twin && (
              <div className="mt-1 rounded bg-zinc-50 p-1.5">
                Looks like <span className="font-medium">{r.twin.name}</span> ({r.twin.folder ?? '—'}): <span className={r.twin.kind === 'same_bytes' || r.twin.kind === 'same_words' ? 'text-emerald-700' : 'text-amber-700'}>{r.twin.note}</span>
                {r.twin.differences.map((d, k) => <div key={k} className="text-zinc-500">{d.onlyInA.length ? `only here: “${d.onlyInA.join(' ')}” ` : ''}{d.onlyInB.length ? `only in the other: “${d.onlyInB.join(' ')}”` : ''}</div>)}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {r.aiTypeSlug && r.aiTypeSlug !== r.currentTypeSlug && <button type="button" disabled={!!busy} onClick={() => setTypeFor(r)} className="rounded-md bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700 disabled:opacity-50">Use this type…</button>}
              {r.aiName && !r.name.toLowerCase().startsWith(r.aiName.toLowerCase()) && <button type="button" disabled={!!busy} onClick={() => void applyName(r)} className="rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 disabled:opacity-50">{busy === r.fileId + 'n' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Use this name'}</button>}
              {r.twin && (r.twin.kind === 'same_bytes' || r.twin.kind === 'same_words') && <button type="button" disabled={!!busy} onClick={() => void removeCopy(r)} className="rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 disabled:opacity-50">Remove this copy</button>}
              {r.analysisId && r.currentTypeSlug && r.currentTypeSlug === r.aiTypeSlug && <button type="button" disabled={!!busy} onClick={async () => { try { await record(r, 'applied'); toast.success('Confirmed — the system learned this'); onChanged() } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save.') } }} className="rounded-md border border-emerald-300 px-2 py-0.5 text-emerald-800 hover:bg-emerald-50">Confirm — this is right</button>}
              {r.analysisId && <button type="button" disabled={!!busy} onClick={() => void dismiss(r)} className="rounded-md border border-zinc-200 px-2 py-0.5 text-zinc-500 hover:bg-zinc-50">Dismiss</button>}
            </div>
          </li>
        ))}
      </ul>
      {typeFor && (
        <SetTypeDialog file={{ id: typeFor.fileId, name: typeFor.name, documentType: typeFor.aiTypeSlug }} onClose={() => setTypeFor(null)}
          onDone={async () => { const r = typeFor; setTypeFor(null); try { await record(r, 'applied') } catch { /* the change itself is done */ } onChanged() }} />
      )}
    </div>
  )
}
