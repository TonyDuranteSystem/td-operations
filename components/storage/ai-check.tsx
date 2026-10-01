'use client'

/**
 * The AI document check INSIDE the storage screen (job 685467b5, Antonio 2026-09-30: "the AI inside the storage, where I can
 * always use it … I want to view the document, otherwise even us can't decide").
 *   · a quiet mark on each checked file row (none / Looks right / Look at this / Doesn't match) — derived on the server from the
 *     file's CURRENT version and type, so it can never be a stale "green"
 *   · "Check files" for a whole company / folder: one file at a time, with the cost shown first, a progress bar and a Stop button
 *   · a side panel that shows the DOCUMENT next to what the AI found, with plain-word buttons; nothing changes until a button is pressed
 * It never changes a file by itself: "Change type" uses the ordinary Set type box, renaming and trashing use the ordinary routes,
 * and every choice is recorded (and teaches the system) through /understand/decision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, AlertTriangle, Loader2, X, ChevronLeft, ChevronRight, ScanText } from 'lucide-react'
import { SetTypeDialog } from './set-type-dialog'
import { FastTooltip } from '@/components/ui/fast-tooltip'

export type AiMarkKind = 'none' | 'looks_right' | 'look' | 'conflict'
export interface FileMark { mark: AiMarkKind; headline: string; reasons: string[]; checkedAt: string | null; analysisId: string | null }
interface Budget { aiOn: boolean; spentTodayUsd: number; capUsd: number; leftUsd: number }
interface Report {
  fileId: string; name: string; folder: string | null; mimeType: string | null
  currentTypeSlug: string | null; currentType: string | null; mark: FileMark
  aiTypeSlug: string | null; aiType: string | null; aiName: string | null; aiReason: string | null
  identity: boolean; problem: string | null; checkedAt: string | null; personalLike: boolean
  twin: { fileId: string; name: string; folder: string | null; mimeType: string | null; kind: string; note: string; differences: Array<{ onlyInA: string[]; onlyInB: string[] }> } | null
  detailTexts: string[]
}

async function jsonOrThrow(r: Response, fallback: string): Promise<Record<string, unknown>> {
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok) throw new Error(typeof j.error === 'string' && j.error ? j.error : fallback)
  return j
}
const post = async (url: string, body: unknown, fallback: string) => jsonOrThrow(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), fallback)
const fmtWhen = (d: string | null) => { try { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '' } catch { return '' } }
const money = (n: number) => `$${n.toFixed(2)}`

// ───────────────────────────────────────────────────────────────────────── marks

/** The marks of the files on screen. `available` is false where the AI check is not allowed (the buttons then stay hidden). */
export function useAiMarks(ownerId: string | null, fileIds: string[]) {
  const [marks, setMarks] = useState<Record<string, FileMark>>({})
  const [available, setAvailable] = useState<boolean | null>(null)
  const key = useMemo(() => Array.from(new Set(fileIds)).sort().join(','), [fileIds])
  const seq = useRef(0)
  const load = useCallback(async (ids: string[]) => {
    if (!ownerId || ids.length === 0) return
    const mine = ++seq.current
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const r = await fetch(`/api/crm-store/understand/marks?owner=${encodeURIComponent(ownerId)}&ids=${ids.slice(i, i + 200).join(',')}`, { cache: 'no-store' })
        if (!r.ok) { if (mine === seq.current) setAvailable(false); return }
        const j = (await r.json()) as { marks: Record<string, FileMark> }
        if (mine === seq.current) { setAvailable(true); setMarks((m) => ({ ...m, ...j.marks })) }
      }
    } catch { /* the marks are a convenience — the screen works without them */ }
  }, [ownerId])
  useEffect(() => { void load(key ? key.split(',') : []) }, [key, load])
  const setOne = useCallback((id: string, m: FileMark) => setMarks((x) => ({ ...x, [id]: m })), [])
  return { marks, available, reload: load, setOne }
}

export function AiMarkChip({ m, onClick }: { m: FileMark | undefined; onClick: () => void }) {
  if (!m || m.mark === 'none') return null
  const s = m.mark === 'looks_right'
    ? { cls: 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50', icon: <Check className="h-3 w-3" />, text: 'Looks right' }
    : m.mark === 'conflict'
      ? { cls: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100', icon: <AlertTriangle className="h-3 w-3" />, text: "Doesn't match" }
      : { cls: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100', icon: <AlertTriangle className="h-3 w-3" />, text: 'Look at this' }
  const tip = `${m.headline}${m.reasons.length ? ' — ' + m.reasons.join(' ') : ''}${m.checkedAt ? ` (checked ${fmtWhen(m.checkedAt)})` : ''}`
  return (
    <FastTooltip label={tip}>
      <button type="button" aria-label={tip} onClick={(e) => { e.stopPropagation(); onClick() }}
        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${s.cls}`} data-testid="ai-mark">{s.icon}{s.text}</button>
    </FastTooltip>
  )
}

// ───────────────────────────────────────────────────────────────────────── check a company / folder

interface Estimate { count: number; alreadyChecked: number; personalSkipped: number; total: number; estimateUsd: number; budget: Budget; fileIds: string[] }

export function AiCheckFilesButton({ ownerId, folderId, scopeLabel, onMark, onFinished }: { ownerId: string; folderId?: string | null; scopeLabel: string; onMark: (id: string, m: FileMark) => void; onFinished: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'estimating' | 'confirm' | 'running'>('idle')
  const [est, setEst] = useState<Estimate | null>(null)
  const [done, setDone] = useState(0)
  const stop = useRef(false)

  const open = async () => {
    setPhase('estimating')
    try {
      const q = folderId ? `folderId=${encodeURIComponent(folderId)}` : `ownerId=${encodeURIComponent(ownerId)}`
      const j = await jsonOrThrow(await fetch(`/api/crm-store/understand/estimate?${q}`, { cache: 'no-store' }), 'Could not work out what to check.')
      setEst(j as unknown as Estimate); setPhase('confirm')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not work out what to check.'); setPhase('idle') }
  }

  const run = async () => {
    if (!est) return
    stop.current = false; setDone(0); setPhase('running')
    let checked = 0, failed = 0, skipped = 0, strikes = 0, reason: string | null = null
    for (const id of est.fileIds) {
      if (stop.current) { reason = 'Stopped.'; break }
      try {
        const j = await post('/api/crm-store/understand/check-file', { fileId: id, bulk: true }, 'The file could not be checked.') as { state: string; message: string | null; mark: FileMark | null }
        if (j.state === 'checked' && j.mark) { checked++; strikes = 0; onMark(id, j.mark) }
        else if (j.state === 'skipped_personal') skipped++
        else if (j.state === 'cap_reached' || j.state === 'ai_off') { reason = j.message; break }
        else if (j.state === 'busy') { /* someone else is checking it — fine */ }
        else { failed++; strikes++ }
      } catch { failed++; strikes++ }
      setDone((n) => n + 1)
      if (strikes >= 3) { reason = 'Stopped after three files in a row could not be checked.'; break }
    }
    setPhase('idle'); onFinished()
    toast[failed || reason ? 'warning' : 'success'](`Checked ${checked} file${checked === 1 ? '' : 's'}${failed ? ` · ${failed} could not be checked` : ''}${skipped ? ` · ${skipped} personal left out` : ''}${reason ? ` — ${reason}` : ''}`)
  }

  return (
    <>
      <button type="button" disabled={phase === 'estimating' || phase === 'running'} onClick={(e) => { e.stopPropagation(); void open() }}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-60" data-testid="ai-check-files">
        {phase === 'estimating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanText className="h-3.5 w-3.5" />}Check files
      </button>
      {phase === 'running' && est && (
        <div className="fixed bottom-4 right-4 z-[70] w-80 rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-lg" role="status">
          <p className="font-medium text-zinc-800">Checking {done} of {est.fileIds.length}…</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-100"><div className="h-full bg-blue-600 transition-all" style={{ width: `${Math.round((done / Math.max(1, est.fileIds.length)) * 100)}%` }} /></div>
          <p className="mt-1 text-zinc-500">You can keep working — keep this tab open.</p>
          <button type="button" onClick={() => { stop.current = true }} className="mt-2 rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50">Stop</button>
        </div>
      )}
      {phase === 'confirm' && est && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setPhase('idle')}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-zinc-900">Check {est.count} file{est.count === 1 ? '' : 's'} in {scopeLabel}?</h3>
            {est.count > 0 ? (
              <p className="mt-2 text-zinc-700">About <strong>{money(est.estimateUsd)}</strong>. Budget left today: <strong>{money(est.budget.leftUsd)}</strong> of {money(est.budget.capUsd)}.{est.estimateUsd > est.budget.leftUsd ? ' That is more than what is left — it will stop when the budget is used up.' : ''}</p>
            ) : <p className="mt-2 text-zinc-700">Nothing new to check here.</p>}
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-500">
              {est.alreadyChecked > 0 && <li>{est.alreadyChecked} already checked — skipped, no cost.</li>}
              {est.personalSkipped > 0 && <li>{est.personalSkipped} personal or ID-like file{est.personalSkipped === 1 ? '' : 's'} left out. Check those one at a time from the file&apos;s menu.</li>}
              {!est.budget.aiOn && <li className="text-amber-700">The AI is switched off here — files would only be read, not judged.</li>}
              <li>The words of each file are sent to the AI service. Nothing is changed in your files.</li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setPhase('idle')} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50">Cancel</button>
              {est.count > 0 && est.budget.aiOn && <button type="button" onClick={() => void run()} className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700" data-testid="ai-check-start">Start</button>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ───────────────────────────────────────────────────────────────────────── the side panel

const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain'])
const isHeic = (name: string, mime: string | null) => /\.(heic|heif)$/i.test(name) || /^image\/hei[cf]/i.test(mime ?? '')

function DocumentView({ fileId, name, mime }: { fileId: string; name: string; mime: string | null }) {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase()
  const src = `/api/crm-store/browse/file/${fileId}`
  if (isHeic(name, mime)) return <img src={`${src}/picture`} alt={name} className="mx-auto h-full max-h-full object-contain" />   // eslint-disable-line @next/next/no-img-element
  if (INLINE.has(m) && m.startsWith('image/')) return <img src={src} alt={name} className="mx-auto h-full max-h-full object-contain" />   // eslint-disable-line @next/next/no-img-element
  if (INLINE.has(m)) return <iframe src={src} title={name} className="h-full w-full border-0" />
  return <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-600"><p>This kind of file cannot be shown here.</p><a href={src} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-blue-700 hover:bg-zinc-50">Download it</a></div>
}

export function AiReviewPanel({ fileId, queue, onClose, onChanged, onOpenFile }: { fileId: string; queue: string[]; onClose: () => void; onChanged: () => void; onOpenFile: (id: string) => void }) {
  const [rep, setRep] = useState<Report | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [typeFor, setTypeFor] = useState(false)
  const [showTwin, setShowTwin] = useState(false)
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [sendOk, setSendOk] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    try { const j = await jsonOrThrow(await fetch(`/api/crm-store/understand/report?fileId=${encodeURIComponent(fileId)}`, { cache: 'no-store' }), 'Could not read the check.'); const r = j.report as Report; setRep(r); setNameDraft(r.aiName ?? r.name.replace(/\.[A-Za-z0-9]{1,5}$/, '')) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the check.') }
  }, [fileId])
  useEffect(() => { setRep(null); setShowTwin(false); setConfirmTrash(false); setSendOk(false); void load() }, [load])

  const idx = queue.indexOf(fileId)
  const go = (d: number) => { const n = queue[idx + d]; if (n) onOpenFile(n) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1) }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  })

  const record = async (action: 'applied' | 'dismissed') => { if (rep?.mark.analysisId) await post('/api/crm-store/understand/decision', { analysisId: rep.mark.analysisId, action }, 'The choice could not be saved.') }
  const act = async (label: string, fn: () => Promise<void>) => { setBusy(label); try { await fn() } catch (e) { toast.error(e instanceof Error ? e.message : 'That did not work — please try again.') } finally { setBusy(null) } }

  const checkNow = () => act('check', async () => {
    const j = await post('/api/crm-store/understand/check-file', { fileId, bulk: false }, 'The file could not be checked.') as { state: string; message: string | null }
    if (j.state !== 'checked') toast.warning(j.message ?? 'The file could not be checked.')
    await load(); onChanged()
  })
  const ext = rep ? (/\.[A-Za-z0-9]{1,5}$/.exec(rep.name)?.[0] ?? '') : ''
  const baseName = rep ? rep.name.replace(/\.[A-Za-z0-9]{1,5}$/, '') : ''
  const saveName = () => act('name', async () => {
    if (!rep) return
    const v = nameDraft.trim()
    if (!v) return
    await post(`/api/crm-store/browse/file/${rep.fileId}/rename`, { name: v + ext }, 'The file could not be renamed.')
    toast.success('Renamed'); await load(); onChanged()
  })
  const yes = () => act('yes', async () => { await record('applied'); toast.success('Thanks — noted'); onChanged(); await load() })
  const notNow = () => act('later', async () => { await record('dismissed'); onChanged(); if (queue[idx + 1]) go(1); else onClose() })
  const trashThis = () => act('trash', async () => {
    await post(`/api/crm-store/browse/file/${fileId}/delete`, {}, 'The copy could not be moved to the trash.')
    toast.success('Moved to the trash — you can restore it'); onChanged(); onClose()
  })

  const same = rep?.aiTypeSlug && rep.aiTypeSlug === rep.currentTypeSlug
  const checked = !!rep && rep.mark.mark !== 'none'

  return (
    <div className="fixed inset-0 z-[66] flex justify-end bg-black/40" onClick={onClose} data-testid="ai-panel">
      <div className="flex h-full w-[min(1180px,96vw)] flex-col bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
          <button type="button" aria-label="Previous file" disabled={idx <= 0} onClick={() => go(-1)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" aria-label="Next file" disabled={idx < 0 || idx >= queue.length - 1} onClick={() => go(1)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{rep?.name ?? 'Loading…'}</span>
          {queue.length > 1 && idx >= 0 && <span className="text-xs text-zinc-400">{idx + 1} of {queue.length} to look at</span>}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        {err && <p className="m-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
        {!rep && !err && <p className="m-4 text-sm text-zinc-500">Loading…</p>}
        {rep && (
          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1.3fr_1fr]">
            <div className="flex min-h-0 flex-col border-r border-zinc-200 bg-zinc-50">
              {rep.twin && (
                <div className="flex gap-1 border-b border-zinc-200 bg-white px-3 py-1.5 text-xs">
                  <button type="button" onClick={() => setShowTwin(false)} className={`rounded px-2 py-0.5 ${!showTwin ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-100'}`}>This file</button>
                  <button type="button" onClick={() => setShowTwin(true)} className={`rounded px-2 py-0.5 ${showTwin ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-100'}`}>The other copy</button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                {showTwin && rep.twin ? <DocumentView fileId={rep.twin.fileId} name={rep.twin.name} mime={rep.twin.mimeType} /> : <DocumentView fileId={rep.fileId} name={rep.name} mime={rep.mimeType} />}
              </div>
            </div>
            <div className="min-h-0 space-y-3 overflow-y-auto p-4 text-sm text-zinc-700">
              <p>Filed as <strong>{rep.currentType ?? 'no type yet'}</strong>{rep.folder ? <span className="text-zinc-400"> · in {rep.folder}</span> : null}</p>

              <div data-testid="ai-name-box">
                <label className="text-xs font-medium text-zinc-600" htmlFor="ai-name-input">File name</label>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <input id="ai-name-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveName() }}
                    className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-sm" />
                  {ext && <span className="text-xs text-zinc-400">{ext}</span>}
                  <button type="button" disabled={!!busy || !nameDraft.trim() || nameDraft.trim() === baseName} onClick={() => void saveName()}
                    className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-50">{busy === 'name' ? 'Saving…' : 'Save name'}</button>
                </div>
                {rep.aiName && rep.aiName !== baseName && (
                  <p className="mt-0.5 text-xs text-zinc-500">The AI suggests “{rep.aiName}”. Type your own name above if you prefer, then press Save name.</p>
                )}
              </div>

              {!checked && (
                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <p className="text-zinc-700">This file has not been checked.</p>
                  {rep.personalLike && !sendOk ? (
                    <div className="mt-2 text-xs text-amber-800">
                      <p>It looks like a personal document (for example a passport or ID). Checking it sends it to the AI service.</p>
                      <button type="button" onClick={() => setSendOk(true)} className="mt-1 rounded-md border border-amber-300 px-2 py-0.5 hover:bg-amber-50">I understand — continue</button>
                    </div>
                  ) : (
                    <button type="button" disabled={busy === 'check'} onClick={() => void checkNow()} className="mt-2 inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-60">
                      {busy === 'check' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanText className="h-3.5 w-3.5" />}Check this file
                    </button>
                  )}
                </div>
              )}

              {checked && (
                <>
                  <p>{rep.aiType ? <>Looks like <strong>{rep.aiType}</strong>.</> : <>The AI could not tell what this is.</>} {rep.aiReason ? <span className="text-zinc-500">{rep.aiReason}</span> : null}</p>
                  {rep.mark.mark !== 'looks_right' && rep.mark.reasons.length > 0 && (
                    <div className={`rounded-md border p-2 text-xs ${rep.mark.mark === 'conflict' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
                      <p className="font-medium">Why it needs a look:</p>
                      <ul className="mt-0.5 list-disc pl-4">{rep.mark.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </div>
                  )}
                  {rep.mark.mark === 'looks_right' && <p className="text-xs text-zinc-500">Looks right — the type matches what the AI read. Checked {fmtWhen(rep.checkedAt)}.</p>}
                  {rep.problem && <p className="text-xs text-amber-700">{rep.problem}</p>}

                  <div className="flex flex-wrap gap-2">
                    {rep.aiTypeSlug && !same && <button type="button" disabled={!!busy} onClick={() => setTypeFor(true)} className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-60" data-testid="ai-change-type">Change type to {rep.aiType}</button>}
                    {same && rep.mark.analysisId && <button type="button" disabled={!!busy} onClick={() => void yes()} className="rounded-md border border-emerald-300 px-3 py-1.5 text-emerald-800 hover:bg-emerald-50 disabled:opacity-60">Yes, correct</button>}
                    <button type="button" disabled={!!busy} onClick={() => void notNow()} className="rounded-md border border-zinc-200 px-3 py-1.5 text-zinc-500 hover:bg-zinc-50 disabled:opacity-60">Not now</button>
                  </div>
                </>
              )}

              {rep.twin && (
                <div className="rounded-md border border-zinc-200 bg-white p-3 text-xs">
                  <p className="font-medium text-zinc-800">Another file looks the same</p>
                  <p className="mt-0.5">“{rep.twin.name}”{rep.twin.folder ? ` (${rep.twin.folder})` : ''} — <span className={rep.twin.kind === 'same_bytes' || rep.twin.kind === 'same_words' ? 'text-emerald-700' : 'text-amber-700'}>{rep.twin.note || (rep.twin.kind === 'same_words' ? 'Every word is the same.' : '')}</span></p>
                  {rep.twin.differences.map((d, k) => <p key={k} className="text-zinc-500">{d.onlyInA.length ? `only here: “${d.onlyInA.join(' ')}” ` : ''}{d.onlyInB.length ? `only in the other: “${d.onlyInB.join(' ')}”` : ''}</p>)}
                  <p className="mt-1 text-zinc-500">Use “The other copy” above to look at both. One may be the signed one.</p>
                  {!confirmTrash ? (
                    (rep.twin.kind === 'same_bytes' || rep.twin.kind === 'same_words') && <button type="button" onClick={() => setConfirmTrash(true)} className="mt-1 text-blue-700 hover:underline">Move the extra copy to the trash…</button>
                  ) : (
                    <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-2">
                      <p>Keep “{rep.twin.name}” and move <strong>this file</strong> (“{rep.name}”) to the trash? It stays in the trash for 90 days and can be restored.</p>
                      <div className="mt-1.5 flex gap-2">
                        <button type="button" disabled={!!busy} onClick={() => void trashThis()} className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 hover:bg-zinc-50 disabled:opacity-60">Yes, move this file to the trash</button>
                        <button type="button" onClick={() => setConfirmTrash(false)} className="rounded-md px-2 py-0.5 text-zinc-500 hover:bg-zinc-100">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {typeFor && rep && (
          <SetTypeDialog file={{ id: rep.fileId, name: rep.name, documentType: rep.aiTypeSlug }} onClose={() => setTypeFor(false)}
            onDone={async () => { setTypeFor(false); try { await record('applied') } catch { /* the change itself is done */ } onChanged(); await load() }} />
        )}
      </div>
    </div>
  )
}
