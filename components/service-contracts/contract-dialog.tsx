'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, Loader2, Pencil, Sparkles, X } from 'lucide-react'
import { editableToWording, toEditable, validateContractWording, type EditableWording, type FieldErrors } from '@/lib/contracts/contract-wording'
import type { ContractVersionView } from '@/lib/contracts/service-contract-view'
import { ContractPreview } from './contract-preview'
import { ContractEditor } from './contract-editor'
import { loadContract, request, sourceLabel, ApiError, type ContractPayload } from './contract-api'

const SAVE_DELAY_MS = 900

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

// (one plain shape, not a tagged union: this project's TypeScript settings do not narrow on the boolean)
interface SaveResult { ok: boolean; why?: 'invalid' | 'server'; message?: string }

/** Same data, whatever the order of the keys (the database hands JSON back with its own key order). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  const ka = Object.keys(a as object), kb = Object.keys(b as object)
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const nameOf = (email: string | null | undefined) =>
  (email ?? '')
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || '—'

type SaveState = 'idle' | 'saving' | 'saved' | 'invalid' | 'error'

/**
 * The Contract pop-up (screens 2, 3 and 6): read the contract exactly as the client will, approve it (owners only),
 * ask Claude for a change in plain words, edit the text yourself, and see every version with who approved it.
 * Approval is tied to the fingerprint of the wording on screen: if the draft changed meanwhile the server refuses.
 */
export function ContractDialog({ entryId, onClose, onChanged }: { entryId: string; onClose: () => void; onChanged: () => void }) {
  const [view, setView] = useState<ContractPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'review' | 'edit'>('review')
  const [editable, setEditable] = useState<EditableWording | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [save, setSave] = useState<SaveState>('idle')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [askText, setAskText] = useState('')
  const [busy, setBusy] = useState<null | 'ask' | 'approve' | 'discard' | 'new' | 'done'>(null)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /** Set when closing was refused because unsaved changes remain: 'invalid' (lines in red) or the server's own reason. */
  const [closeWarn, setCloseWarn] = useState<string | null>(null)

  const hashRef = useRef('')
  const dirtyRef = useRef(false)
  const editSeq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const editableRef = useRef<EditableWording | null>(null)
  /** The wording of the most recent save attempt (to recognise our own write when its answer was lost). */
  const lastSent = useRef<unknown>(null)

  const viewRef = useRef<ContractPayload | null>(null)
  viewRef.current = view
  const busyRef = useRef<typeof busy>(null)
  busyRef.current = busy
  const draft = view?.versions.find((v) => v.status === 'draft') ?? null
  const selected = view?.versions.find((v) => v.id === selectedId) ?? null

  const reload = useCallback(async (selectId?: string | null) => {
    try {
      const data = await loadContract(entryId)
      setView(data)
      setLoadError(null)
      setSelectedId((cur) => {
        const ids = data.versions.map((v) => v.id)
        if (selectId && ids.includes(selectId)) return selectId
        if (cur && ids.includes(cur)) return cur
        return (data.versions.find((v) => v.status === 'draft') ?? data.versions.find((v) => v.status === 'approved') ?? data.versions[0])?.id ?? null
      })
      return data
    } catch (e) {
      const why = e instanceof Error ? e.message : 'Could not open the contract.'
      // once the contract is on screen a failed re-read must not wipe it (and the work in it): say so and keep going
      if (viewRef.current) setMessage({ kind: 'error', text: why })
      else setLoadError(why)
      return null
    }
  }, [entryId])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // ── saving while editing ────────────────────────────────────────────────────────────────
  const saveNow = useCallback((next: EditableWording): Promise<SaveResult> => {
    const run = async (): Promise<SaveResult> => {
      const checked = editableToWording(next)
      if ('errors' in checked) { setFieldErrors(checked.fields); setSave('invalid'); return { ok: false, why: 'invalid' } }
      const draftId = view?.versions.find((v) => v.status === 'draft')?.id
      if (!draftId) {
        const message = 'There is no open draft to save into.'
        setSave('error'); setMessage({ kind: 'error', text: message })
        return { ok: false, why: 'server', message }
      }
      const seq = editSeq.current
      const sentBefore = lastSent.current
      lastSent.current = checked.wording
      setSave('saving')
      const put = (hash: string) => request<{ version: ContractVersionView }>(`/api/service-contracts/versions/${draftId}`, { method: 'PUT', body: { content: checked.wording, expectedHash: hash } })
      const saved = (version: ContractVersionView): SaveResult => {
        hashRef.current = version.hash
        setView((v) => v && ({ ...v, versions: v.versions.map((x) => (x.id === version.id ? version : x)) }))
        if (seq === editSeq.current) { dirtyRef.current = false; setSave('saved'); setFieldErrors({}) }
        return { ok: true }
      }
      try {
        return saved((await put(hashRef.current)).version)
      } catch (e) {
        if (e instanceof ApiError && e.data?.fields) setFieldErrors(e.data.fields as FieldErrors)
        // A save can reach the server while its ANSWER is lost (a network blip). The next save would then be refused against
        // our OWN earlier write. Look at what is really stored: if it is exactly something we sent, it is ours — carry on from it.
        if (e instanceof ApiError && e.data?.code === 'DRAFT_CHANGED') {
          try {
            const fresh = await loadContract(entryId)
            const stored = fresh.versions.find((v) => v.id === draftId)
            if (stored && stored.status === 'draft') {
              if (sameJson(stored.content, checked.wording)) return saved(stored) // this very text is already stored
              if (sentBefore && sameJson(stored.content, sentBefore)) return saved((await put(stored.hash)).version) // our earlier write landed: save the newer text on top of it
            }
          } catch { /* fall through to the real message */ }
        }
        const message = e instanceof Error ? e.message : 'Could not save.'
        setSave('error')
        setMessage({ kind: 'error', text: message })
        return { ok: false, why: 'server', message }
      }
    }
    const p = chain.current.then(run, run)
    chain.current = p
    return p
  }, [view, entryId])

  const onEdit = (next: EditableWording) => {
    editableRef.current = next
    setEditable(next)
    dirtyRef.current = true
    editSeq.current += 1
    setMessage(null)
    const checked = editableToWording(next)
    setFieldErrors('fields' in checked ? checked.fields : {})
    if (timer.current) clearTimeout(timer.current)
    if ('errors' in checked) { setSave('invalid'); return }
    setSave('idle')
    timer.current = setTimeout(() => { void saveNow(next) }, SAVE_DELAY_MS)
  }

  /** Save whatever is pending right now. { ok: true } when nothing is left unsaved. */
  const flush = async (): Promise<SaveResult> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (mode !== 'edit' || !dirtyRef.current || !editableRef.current) return { ok: true }
    return saveNow(editableRef.current)
  }

  const startEdit = () => {
    if (!draft) return
    const w = validateContractWording(draft.content)
    if ('errors' in w) { setMessage({ kind: 'error', text: 'This draft is not valid wording: ' + w.errors.join('; ') }); return }
    const e = toEditable(w.wording)
    editableRef.current = e
    setEditable(e)
    hashRef.current = draft.hash
    lastSent.current = null
    dirtyRef.current = false
    editSeq.current = 0
    setFieldErrors({})
    setSave('idle')
    setMessage(null)
    setConfirmApprove(false)
    setMode('edit')
  }

  const doneEditing = async () => {
    setBusy('done')
    const res = await flush()
    if (!res.ok) {
      setBusy(null)
      // a server problem already put its real reason on screen; only a validation problem needs this sentence
      if (res.why === 'invalid') setMessage({ kind: 'error', text: 'Some lines have problems (shown in red). Fix them, then press Done editing.' })
      return
    }
    await reload(draft?.id)
    setMode('review')
    setBusy(null)
    onChanged()
  }

  const ask = async () => {
    const text = askText.trim()
    if (!text || !draft) return
    setBusy('ask')
    setMessage(null)
    setConfirmApprove(false)
    const saved = await flush()
    if (!saved.ok) {
      setBusy(null)
      if (saved.why === 'invalid') setMessage({ kind: 'error', text: 'Fix the lines shown in red first, then ask Claude.' })
      return
    }
    try {
      const out = await request<{ version: ContractVersionView }>(`/api/service-contracts/versions/${draft.id}/ask`, { method: 'POST', body: { request: text } })
      await reload(out.version.id)
      if (mode === 'edit') {
        const w = validateContractWording(out.version.content)
        if (!('errors' in w)) { const e = toEditable(w.wording); editableRef.current = e; setEditable(e); hashRef.current = out.version.hash; dirtyRef.current = false; setFieldErrors({}); setSave('saved') }
      }
      setAskText('')
      setMessage({ kind: 'ok', text: 'Claude changed the draft. Read it again before you approve.' })
      onChanged()
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Claude could not make that change.' })
      // the change may have been saved even though the answer never arrived: show what is really stored, and — if the
      // editor has nothing unsaved — take on its fingerprint, or the next autosave would be refused against it
      const data = await reload()
      const stored = data?.versions.find((v) => v.status === 'draft')
      if (stored && mode === 'edit' && !dirtyRef.current) {
        const w = validateContractWording(stored.content)
        if (!('errors' in w)) { const ed = toEditable(w.wording); editableRef.current = ed; setEditable(ed); hashRef.current = stored.hash }
      }
    } finally {
      setBusy(null)
    }
  }

  const approve = async () => {
    if (!draft) return
    setBusy('approve')
    setMessage(null)
    try {
      const out = await request<{ version: ContractVersionView }>(`/api/service-contracts/versions/${draft.id}/approve`, { method: 'POST', body: { expectedHash: draft.hash } })
      setConfirmApprove(false)
      await reload(out.version.id)
      setMessage({ kind: 'ok', text: `Approved. Version ${out.version.version} is now the contract used on new offers. Offers already sent keep the wording they were sent with.` })
      onChanged()
    } catch (e) {
      setConfirmApprove(false)
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not approve.' })
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const discard = async () => {
    if (!draft) return
    setBusy('discard')
    setConfirmApprove(false)
    try {
      await request(`/api/service-contracts/versions/${draft.id}`, { method: 'DELETE' })
      setConfirmDiscard(false)
      setMode('review')
      dirtyRef.current = false
      onChanged()
      const data = await reload()
      if (!data || data.versions.length === 0) onClose()
    } catch (e) {
      setConfirmDiscard(false)
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not throw the draft away.' })
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const newVersion = async () => {
    setBusy('new')
    setMessage(null)
    setConfirmApprove(false)
    try {
      const out = await request<{ version: ContractVersionView }>(`/api/service-contracts/${entryId}/draft`, { method: 'POST', body: { mode: 'from_approved' } })
      await reload(out.version.id)
      setMessage({ kind: 'ok', text: `Version ${out.version.version} started as a copy of the approved wording. Edit it yourself or ask Claude for a change, then approve it.` })
      onChanged()
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not start a new version.' })
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const tryClose = async () => {
    const res = await flush()
    if (!res.ok) { setCloseWarn(res.why === 'invalid' ? 'invalid' : res.message ?? 'server'); return }
    onClose()
  }
  const closeRef = useRef(tryClose)
  closeRef.current = tryClose
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    dialogRef.current?.focus()
    // (not while something is being saved, asked of Claude or approved: closing then would race with it)
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && !busyRef.current) void closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── what is shown ───────────────────────────────────────────────────────────────────────
  const wordingOf = (v: ContractVersionView | null) => {
    if (!v) return null
    const w = validateContractWording(v.content)
    return 'errors' in w ? null : w.wording
  }
  const shown = wordingOf(selected)
  const isOpenDraft = !!selected && selected.status === 'draft'
  const canApprove = !!view?.viewer.canApprove
  const editing = mode === 'edit' && isOpenDraft

  const subtitle = !selected ? '' :
    selected.status === 'draft' ? `Draft ${selected.version} · ${sourceLabel(selected)} · ${editing ? 'you are editing it' : 'this is what the client will read'}` :
    selected.status === 'approved' ? `Version ${selected.version} · approved by ${nameOf(selected.approvedBy)} on ${fmtDate(selected.approvedAt)} · this is what the client reads` :
    `Version ${selected.version} · replaced · shown for the record`

  return (
    <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3 outline-none" role="dialog" aria-modal="true" aria-label="Contract" data-contract-dialog>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[92vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900">Contract for {view?.service.name ?? '…'}</h2>
            <p className="text-sm text-zinc-500 mt-0.5" data-contract-subtitle>{subtitle}</p>
          </div>
          <button type="button" onClick={tryClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700"><X className="h-5 w-5" /></button>
        </div>

        {closeWarn && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-900 flex items-center justify-between gap-3" data-close-warning>
            <span>{closeWarn === 'invalid' ? 'Some of your changes have not been saved (the lines in red have problems).' : `Your latest changes could not be saved: ${closeWarn}`}</span>
            <span className="flex gap-2">
              <button type="button" className="underline" onClick={() => setCloseWarn(null)}>Keep editing</button>
              <button type="button" className="underline text-red-700" onClick={onClose}>Close without saving them</button>
            </span>
          </div>
        )}

        {loadError ? (
          <div className="p-8 text-sm text-red-700 flex items-start gap-2"><AlertCircle className="h-4 w-4 mt-0.5" />{loadError}</div>
        ) : !view || !selected ? (
          <div className="p-10 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Opening the contract…</div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            <div className="flex-1 min-w-0 min-h-[40vh] overflow-y-auto bg-zinc-100 p-4 lg:p-6">
              <div className="mx-auto max-w-[8.5in] bg-white shadow-sm border border-zinc-200 px-8 py-8" data-contract-paper>
                {editing && editable ? (
                  <ContractEditor value={editable} onChange={onEdit} fieldErrors={fieldErrors} disabled={busy === 'ask' || busy === 'done'} />
                ) : shown ? (
                  <ContractPreview wording={shown} serviceName={view.service.name} serviceDescription={view.service.description} price={view.service.price} currency={view.service.currency} />
                ) : (
                  <p className="text-sm text-red-700">This version’s wording is not valid, so it cannot be shown. Ask Claude to write it again.</p>
                )}
              </div>
            </div>

            <aside className="w-full md:w-[23rem] shrink-0 border-t md:border-t-0 md:border-l overflow-y-auto max-h-[45vh] md:max-h-none p-5 space-y-4 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${selected.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : selected.status === 'draft' ? 'bg-amber-100 text-amber-800' : 'bg-zinc-200 text-zinc-700'}`} data-status-chip>
                  {selected.status === 'draft' ? `Draft ${selected.version} · ${editing ? 'editing' : 'not approved'}` : selected.status === 'approved' ? `Version ${selected.version} · approved` : `Version ${selected.version} · replaced`}
                </span>
                {editing && (
                  <span className="text-xs text-zinc-500" data-save-state>
                    {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'invalid' ? 'Not saved — fix the lines in red' : save === 'error' ? 'Could not save' : 'Changes are kept as you type'}
                  </span>
                )}
              </div>

              {message && (
                <div className={`flex items-start gap-2 rounded-md px-3 py-2 ${message.kind === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800'}`} data-contract-message>
                  {message.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <span>{message.text}</span>
                </div>
              )}

              {isOpenDraft && !editing && (
                <>
                  <p className="flex items-start gap-2 text-zinc-600"><Info className="h-4 w-4 mt-0.5 shrink-0" />Approving freezes this exact text. A later change is a new version; offers already sent keep the version they were sent with.</p>
                  {confirmApprove ? (
                    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 space-y-2" data-approve-confirm>
                      <p className="text-emerald-900">Approve draft {selected.version} as it is on screen?</p>
                      <div className="flex gap-2">
                        <button type="button" disabled={!!busy} onClick={approve} className="px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5">{busy === 'approve' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Yes, approve</button>
                        <button type="button" disabled={busy === 'approve'} onClick={() => setConfirmApprove(false)} className="px-3 py-1.5 rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <button type="button" disabled={!canApprove || !!busy || !shown} onClick={() => setConfirmApprove(true)} className="w-full px-3 py-2 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:bg-zinc-200 disabled:text-zinc-500 disabled:cursor-not-allowed" data-approve-button>
                        Approve this wording
                      </button>
                      {!canApprove && <p className="mt-1 text-xs text-zinc-500" data-approve-reason>Only the owner can approve a contract.</p>}
                    </div>
                  )}
                  <button type="button" disabled={!!busy} onClick={startEdit} className="w-full px-3 py-2 rounded-md border border-zinc-300 text-zinc-800 hover:bg-zinc-50 inline-flex items-center justify-center gap-1.5 disabled:opacity-50" data-edit-button>
                    <Pencil className="h-3.5 w-3.5" />Edit the text myself
                  </button>
                </>
              )}

              {editing && (
                <>
                  <p className="flex items-start gap-2 text-zinc-600"><Info className="h-4 w-4 mt-0.5 shrink-0" />To make words bold, put two stars on each side: <strong>**like this**</strong>. The client sees them bold, without the stars.</p>
                  <button type="button" disabled={!!busy} onClick={doneEditing} className="w-full px-3 py-2 rounded-md bg-zinc-900 text-white font-medium hover:bg-zinc-700 disabled:opacity-50 inline-flex items-center justify-center gap-1.5" data-done-editing>
                    {busy === 'done' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Done editing
                  </button>
                  <p className="text-xs text-zinc-500">“Done editing” shows the contract exactly as the client will read it, and only then can you approve.</p>
                </>
              )}

              {isOpenDraft && (
                <div className="space-y-2 pt-1">
                  <label htmlFor="contract-ask-input" className="block font-medium text-zinc-800">{editing ? 'Or ask Claude to change something' : 'Ask Claude to change something'}</label>
                  <textarea id="contract-ask-input" value={askText} onChange={(e) => setAskText(e.target.value)} rows={3} disabled={!!busy} placeholder="For example: add that documents must be in English or officially translated." className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" data-ask-input />
                  <button type="button" disabled={!askText.trim() || !!busy || !view.aiConfigured} onClick={ask} className="px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5" data-ask-button>
                    {busy === 'ask' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Ask Claude
                  </button>
                  {busy === 'ask' && <p className="text-xs text-zinc-500">Claude is changing the wording — this takes up to a minute.</p>}
                  {!view.aiConfigured && <p className="text-xs text-zinc-500">Claude is not set up on this server, so this button is off.</p>}
                </div>
              )}

              {selected.status === 'approved' && !draft && (
                <button type="button" disabled={!!busy} onClick={newVersion} className="w-full px-3 py-2 rounded-md border border-zinc-300 text-zinc-800 hover:bg-zinc-50 inline-flex items-center justify-center gap-1.5 disabled:opacity-50" data-new-version>
                  {busy === 'new' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Start a new version
                </button>
              )}
              {selected.status === 'approved' && draft && <p className="text-xs text-zinc-500">A newer draft (version {draft.version}) is waiting. Open it from the history below.</p>}
              {selected.status !== 'draft' && <p className="text-xs text-zinc-500">An approved version can never be edited, only replaced by a newer one.</p>}

              {isOpenDraft && (
                confirmDiscard ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2">
                    <p className="text-red-800">Throw away draft {selected.version}? This cannot be undone.</p>
                    <div className="flex gap-2">
                      <button type="button" disabled={busy === 'discard'} onClick={discard} className="px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">Yes, throw it away</button>
                      <button type="button" onClick={() => setConfirmDiscard(false)} className="px-3 py-1.5 rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" disabled={!!busy} onClick={() => setConfirmDiscard(true)} className="text-xs text-red-700 hover:underline disabled:opacity-50">Throw away this draft</button>
                )
              )}

              <div className="pt-2 border-t">
                <h3 className="font-medium text-zinc-800 mb-2">History · {view.versions.length} version{view.versions.length === 1 ? '' : 's'}</h3>
                <table className="w-full text-xs" data-history>
                  <thead>
                    <tr className="text-left text-zinc-500">
                      <th className="font-medium pb-1">Ver.</th><th className="font-medium pb-1">Status</th><th className="font-medium pb-1">Approved by</th><th className="font-medium pb-1">Date</th><th className="font-medium pb-1 text-right">Offers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.versions.map((v) => (
                      <tr key={v.id} className={`border-t ${v.id === selected.id ? 'bg-blue-50' : 'hover:bg-zinc-50'}`}>
                        <td className="py-1.5"><button type="button" disabled={editing} onClick={() => { setSelectedId(v.id); setConfirmApprove(false); setMessage(null) }} className="font-medium text-blue-700 hover:underline disabled:text-zinc-400 disabled:no-underline">{v.version}</button></td>
                        <td className="py-1.5">{v.status === 'draft' ? 'Draft' : v.status === 'approved' ? 'Approved — in use' : 'Replaced'}</td>
                        <td className="py-1.5">{v.approvedBy ? nameOf(v.approvedBy) : '—'}</td>
                        <td className="py-1.5">{fmtDate(v.approvedAt ?? v.createdAt)}</td>
                        <td className="py-1.5 text-right">{v.status === 'draft' ? '—' : v.offersSent}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-zinc-500">“Offers” counts the offers sent with that exact wording.</p>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}
