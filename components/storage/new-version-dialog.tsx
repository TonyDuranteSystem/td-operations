'use client'

/**
 * "Upload edited version…": the staff member picks the edited file; it is saved as the NEXT VERSION of the same file (dev job bd21e833,
 * master plan Part 54). The old copy is kept under "older copies". Plain words for every outcome: saved, someone else changed it
 * (choose: cancel, or keep mine as a hidden "not applied" version), locked (signed / passport-ID / replaced / filed), amended return
 * (typed reason). Each attempt stages the chosen file again, so a retry never depends on a leftover upload.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { trapTabKey } from '@/components/storage/focus-trap'
import { putFileWithRetry } from '@/lib/storage/put-with-retry'
import { checkReplacement, lockText, warningText, type ReplaceWarning } from '@/lib/crm-store/new-version-rules'

const STAGING_PREFIX = 'crm-uploads/store-staging/'

export interface EditTarget { id: string; name: string; mimeType: string | null; size: number | null; versionNo: number; ownerId: string; /** the client sees this file now */ clientVisible?: boolean; /** a workspace always shows it, so it cannot be hidden */ alwaysShown?: boolean }

type Reply = { status: string; message: string; versionNo?: number; token?: string | null; warnings?: ReplaceWarning[]; error?: string }
type Phase =
  | { k: 'pick' }
  | { k: 'warn'; file: File; warnings: ReplaceWarning[] }
  | { k: 'saving' }
  | { k: 'done'; message: string; tone: 'ok' | 'info' }
  | { k: 'conflict'; file: File; message: string }
  | { k: 'blocked'; message: string }
  | { k: 'amended'; file: File; token: string | null; message: string }

export function NewVersionDialog({ target, onClose, onSaved }: { target: EditTarget; onClose: () => void; onSaved: () => void }) {
  const [phase, setPhase] = useState<Phase>({ k: 'pick' })
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [hide, setHide] = useState(false)

  // always refresh the list on the way out: after a conflict the page's version number is out of date
  const close = () => { onSaved(); onClose() }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase.k !== 'saving') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k])

  const send = async (file: File, extra0: { acceptWarnings?: boolean; keepUnmerged?: boolean; reason?: string; confirmToken?: string | null }) => {
    const extra = { ...extra0, clientChoice: hide ? 'hide' : 'keep' }
    setPhase({ k: 'saving' }); setError(null)
    try {
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)
      const put = await putFileWithRetry({
        file,
        prepare: async () => {
          const path = `${STAGING_PREFIX}${target.ownerId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`
          const res = await fetch('/api/storage/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket: 'onboarding-uploads', path, contentType: file.type }) })
          const d = await res.json().catch(() => ({})) as { signedUrl?: string; error?: string }
          if (!res.ok || !d.signedUrl) throw new Error(d.error || 'Could not prepare the upload.')
          return { signedUrl: d.signedUrl, path }
        },
      })
      if (!put.ok) throw new Error(put.message)
      const res = await fetch(`/api/crm-store/browse/file/${target.id}/new-version`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: put.path, fileName: file.name, mimeType: file.type, baseVersionNo: target.versionNo, ...extra }),
      })
      const r = await res.json().catch(() => ({})) as Reply
      if (!res.ok) throw new Error(r.error || 'The new version could not be saved — please try again.')
      if (r.status === 'versioned') { setPhase({ k: 'done', message: r.message, tone: 'ok' }) }
      else if (r.status === 'unmerged') { setPhase({ k: 'done', message: r.message, tone: 'info' }) }
      else if (r.status === 'unchanged') setPhase({ k: 'done', message: r.message, tone: 'info' })
      else if (r.status === 'conflict') setPhase({ k: 'conflict', file, message: r.message })
      else if (r.status === 'locked' || r.status === 'frozen' || r.status === 'trashed' || r.status === 'not_found') setPhase({ k: 'blocked', message: r.message })
      else if (r.status === 'needs_confirmation') setPhase({ k: 'amended', file, token: r.token ?? null, message: r.message })
      else if (r.warnings?.length) setPhase({ k: 'warn', file, warnings: r.warnings })
      else setPhase({ k: 'blocked', message: r.message || 'The file was not saved.' })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The new version could not be saved — please try again.')
      setPhase({ k: 'pick' })
    }
  }

  const onPick = (file: File) => {
    const chk = checkReplacement({ name: target.name, mimeType: target.mimeType, size: target.size }, { name: file.name, mimeType: file.type || null, size: file.size })
    if (chk.block) { setError(chk.block); return }
    if (chk.warnings.length) { setPhase({ k: 'warn', file, warnings: chk.warnings }); return }
    void send(file, {})
  }

  const btn = 'rounded-md px-3 py-1.5 text-sm font-medium'
  const body = (() => {
    if (phase.k === 'pick') return (
      <>
        <p className="text-sm text-zinc-700">Choose the edited file. It is saved as the next version of <b>{target.name}</b> (now version {target.versionNo}). The current copy stays under “older copies”.</p>
        {target.clientVisible && !target.alwaysShown && (
          <fieldset className="mt-3 rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
            <legend className="px-1 text-xs text-zinc-500">The client can see this file now. After saving:</legend>
            <label className="flex items-center gap-2"><input type="radio" name="client-choice" checked={!hide} onChange={() => setHide(false)} />The client sees the new version</label>
            <label className="mt-1 flex items-center gap-2"><input type="radio" name="client-choice" checked={hide} onChange={() => setHide(true)} />Hide it from the client (they never see the new version)</label>
          </fieldset>
        )}
        {target.clientVisible && target.alwaysShown && <p className="mt-3 text-sm text-amber-700">A workspace always shows this file to the client, so the client will see the new version.</p>}
        {error && <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <input ref={inputRef} type="file" className="hidden" data-testid="new-version-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f) }} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={close} className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-50`}>Cancel</button>
          <button type="button" autoFocus onClick={() => inputRef.current?.click()} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}><Upload className="mr-1 inline h-3.5 w-3.5" />Choose the edited file…</button>
        </div>
      </>
    )
    if (phase.k === 'warn') return (
      <>
        <ul className="space-y-2 text-sm text-zinc-700">{phase.warnings.map((w) => <li key={w}>{warningText(w, target.name, phase.file.name)}</li>)}</ul>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" autoFocus onClick={() => setPhase({ k: 'pick' })} className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-50`}>Cancel</button>
          <button type="button" onClick={() => void send(phase.file, { acceptWarnings: true })} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>Save as the new version</button>
        </div>
      </>
    )
    if (phase.k === 'saving') return <p className="flex items-center gap-2 text-sm text-zinc-700"><Loader2 className="h-4 w-4 animate-spin" />Saving…</p>
    if (phase.k === 'done') return (
      <>
        <p role="status" className={`text-sm ${phase.tone === 'ok' ? 'text-emerald-700' : 'text-zinc-700'}`}>{phase.message}</p>
        <div className="mt-4 flex justify-end"><button type="button" autoFocus onClick={close} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>Done</button></div>
      </>
    )
    if (phase.k === 'conflict') return (
      <>
        <p className="text-sm text-zinc-700">{phase.message}</p>
        <p className="mt-2 text-sm text-zinc-500">You can keep your file as a hidden “not applied” version — nothing is lost, and you can look at it and decide later.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" autoFocus onClick={close} className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-50`}>Cancel</button>
          <button type="button" onClick={() => void send(phase.file, { acceptWarnings: true, keepUnmerged: true })} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>Keep mine as a hidden version</button>
        </div>
      </>
    )
    if (phase.k === 'blocked') return (
      <>
        <p className="text-sm text-zinc-700">{phase.message}</p>
        <div className="mt-4 flex justify-end"><button type="button" autoFocus onClick={close} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>Close</button></div>
      </>
    )
    return (
      <>
        <p className="text-sm text-zinc-700">{phase.message}</p>
        {!phase.token && <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Changing an amended return is not available right now (the confirmation is not set up on this server).</p>}
        <label className="mt-3 block text-sm text-zinc-700">Why is it being changed?
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" autoFocus onClick={close} className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-50`}>Cancel</button>
          <button type="button" disabled={!phase.token || reason.trim().length < 3} onClick={() => void send(phase.file, { acceptWarnings: true, reason: reason.trim(), confirmToken: phase.token })}
            className={`${btn} bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50`}>I confirm — save the change</button>
        </div>
      </>
    )
  })()

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/40 px-4" onMouseDown={(e) => { if (e.target === e.currentTarget && phase.k !== 'saving') close() }}>
      <div ref={rootRef} role="dialog" aria-modal="true" aria-label="Upload edited version" tabIndex={-1}
        onKeyDown={(e) => trapTabKey(e)}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-zinc-900">Upload edited version</h2>
          {phase.k !== 'saving' && <button type="button" aria-label="Close" onClick={close} className="text-zinc-400 hover:text-zinc-700"><X className="h-4 w-4" /></button>}
        </div>
        {body}
      </div>
    </div>
  )
}

export { lockText }
