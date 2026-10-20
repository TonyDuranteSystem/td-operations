'use client'

/**
 * "Where should this be saved?" — the ONE required window staff see wherever they save a document into the CRM storage
 * (Antonio 2026-10-20, dev job c43a8b2e; approved mockup = screens 1 and 2). The Fax tool is the first user.
 *
 * - It cannot be dismissed by accident: no X, Escape does nothing, a click on the dark backdrop does nothing. The only ways out are
 *   "Save here and send", "Change place" then save, or a deliberate "Don't save, just send".
 * - It asks what the fax is and (for the IRS papers) which company, then shows the PROPOSED place and WHY, in plain words. Nothing is
 *   guessed from the file name. "Change place" opens the whole storage (FolderPicker: any company, any person, Business, My files,
 *   search, "+ New folder here").
 * - The file name is an editable box.
 * - The place is checked by the server BEFORE anything is sent; if it is refused, the sentence shows here and the window stays open.
 *
 * The rules that propose a place live in `lib/crm-store/save-where.ts`, the checks in `lib/crm-store/save-destination.ts`. A new save
 * point reuses this window by passing its own `purposes` (and, until it has its own endpoint, the same propose route).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { FolderPicker } from '@/components/storage/store-dialogs'
import { trapTabKey, trapTarget } from '@/components/storage/focus-trap'
import { answersKey, canSave, needsRepropose, pickedAfterAnswersChange, proposalIsCurrent, showsWorking, type CompanyAnswer } from '@/lib/crm-store/save-where-state'
import type { FaxPurpose } from '@/lib/crm-store/save-where'

export { trapTarget }

export type SaveWhereChoice =
  | { mode: 'save'; purpose: FaxPurpose; ownerId: string; folderId: string; newFolderName: string | null; fileName: string; proposalOf: { accountId: string | null; business: boolean } | null }
  | { mode: 'dont_save' }

export interface ResolvedProposalDTO {
  state: 'proposed' | 'choose' | 'refused'
  why: string
  path?: string
  ownerId?: string
  folderId?: string
  newFolderName?: string | null
  documentType?: string | null
}

/**
 * Keeps the page behind the window out of reach while it is open: no scrolling, nothing behind it can take focus or be clicked (`inert`),
 * Escape is swallowed even when focus has fallen to the page (a click on the backdrop must not make Escape reach a listener behind), and a
 * click on the backdrop does not move focus out of the window. Renders nothing; everything is undone when the window goes away.
 */
function DialogEffects({ labelledBy }: { labelledBy: string }) {
  useEffect(() => {
    const dlg = document.getElementById(labelledBy)?.closest('[role="dialog"]') as HTMLElement | null
    if (!dlg) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const inerted: Element[] = []
    let node: Element | null = dlg.parentElement
    while (node && node.parentElement) {
      const parent: Element = node.parentElement
      for (const sib of Array.from(parent.children)) {
        if (sib !== node && !sib.hasAttribute('inert') && sib.tagName !== 'SCRIPT' && sib.tagName !== 'STYLE') { sib.setAttribute('inert', ''); inerted.push(sib) }
      }
      node = parent === document.documentElement ? null : parent
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() } }
    const onDown = (e: MouseEvent) => { if (!dlg.contains(e.target as Node)) e.preventDefault() }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
      for (const el of inerted) el.removeAttribute('inert')
      document.body.style.overflow = overflow
    }
  }, [labelledBy])
  return null
}

/**
 * The shell: a modal that CANNOT be dismissed by accident. Deliberately takes no `onClose`, renders no close button, and puts no click
 * handler on the backdrop. Escape is swallowed (so nothing behind it, e.g. a window-level key listener, reacts either). Tab stays inside.
 */
export function RequiredDialog({ labelledBy, children }: { labelledBy: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return }
          trapTabKey(e)
        }}
        className="flex max-h-[94vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-xl bg-white p-4 shadow-xl sm:p-6"
      >
        <DialogEffects labelledBy={labelledBy} />
        {children}
      </div>
    </div>
  )
}

interface CompanyHit { accountId: string; name: string; status: string | null }

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error((d as { error?: string }).error || 'Could not work out the place. Please try again.')
  return d
}

export function SaveWhereDialog({
  fileName, purposes, purposeQuestion = 'What is this fax?', companyPurposes, saveLabel = 'Save here and send', skipLabel = "Don't save, just send", onDecide,
}: {
  /** the uploaded file's own name (pre-fills the editable box) */
  fileName: string
  purposes: ReadonlyArray<{ key: FaxPurpose; label: string }>
  purposeQuestion?: string
  /** the purposes that need "Which company?" */
  companyPurposes: ReadonlyArray<FaxPurpose>
  saveLabel?: string
  skipLabel?: string
  /** Called with the choice. Resolve with { error } to keep the window open and show the sentence; resolve without to let the caller close it. */
  onDecide: (c: SaveWhereChoice) => Promise<{ error?: string } | void>
}) {
  const [purpose, setPurpose] = useState<FaxPurpose | null>(null)
  const [company, setCompany] = useState<CompanyAnswer>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CompanyHit[]>([])
  const [proposal, setProposal] = useState<ResolvedProposalDTO | null>(null)
  const [proposalKey, setProposalKey] = useState<string | null>(null)   // the answers the shown proposal was made for
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState(fileName)
  const [picked, setPicked] = useState<{ ownerId: string; folderId: string; newFolderName: string | null; path: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const requestedKey = useRef<string | null>(null)   // the answers of the request already on its way
  const prevAnswers = useRef<{ purpose: FaxPurpose | null; company: CompanyAnswer }>({ purpose: null, company: null })
  const changeBtn = useRef<HTMLButtonElement>(null)

  const needsCompany = !!purpose && companyPurposes.includes(purpose)

  // company typeahead (only the newest search may fill the list)
  useEffect(() => {
    if (!needsCompany || company || query.trim().length < 2) { setHits([]); return }
    let cancelled = false   // a newer search (or a closed list) makes this one's answer irrelevant
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/crm-store/save-where/companies?q=${encodeURIComponent(query.trim())}`, { cache: 'no-store' })
        const d = await res.json().catch(() => ({})) as { companies?: CompanyHit[]; error?: string }
        if (!res.ok) throw new Error(d.error || 'Could not search the companies.')
        if (!cancelled) setHits(d.companies ?? [])
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not search the companies.') }
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query, needsCompany, company])

  const propose = useCallback(async (p: FaxPurpose, c: CompanyAnswer, n: string) => {
    const mine = ++seq.current
    const key = answersKey(p, c, n)
    requestedKey.current = key
    setLoading(true); setError(null)
    try {
      const d = await postJson<ResolvedProposalDTO>('/api/crm-store/save-where/propose', {
        purpose: p, fileName: n,
        accountId: c && c !== 'business' ? c.accountId : undefined, business: c === 'business' ? true : undefined,
      })
      if (mine === seq.current) { setProposal(d); setProposalKey(key) }
    } catch (e) {
      if (mine === seq.current) { setProposal(null); setProposalKey(null); setError(e instanceof Error ? e.message : 'Could not work out the place. Please try again.') }
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  // a new answer → a new proposal (a place staff chose by hand no longer applies to a different fax / company)
  useEffect(() => {
    const next = { purpose, company }
    setPicked((p) => pickedAfterAnswersChange(prevAnswers.current, next, p))
    prevAnswers.current = next
    if (!purpose) { setProposal(null); setProposalKey(null); requestedKey.current = null; return }
    void propose(purpose, company, name)
    // the file name only matters for a tax return's year — that is handled by the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose, company, propose])

  const ws = { purpose, company, name, loading, proposalKey, requestedKey: requestedKey.current, proposalState: proposal?.state ?? null, picked, busy }

  // the year of a tax return comes from the file name: when the name is edited the proposal is made again (after a short pause)
  useEffect(() => {
    if (!purpose || !needsRepropose({ ...ws })) return
    const t = setTimeout(() => { void propose(purpose, company, name) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, purpose, company, picked, proposalKey, propose])

  const current = proposalIsCurrent(ws)
  const working = showsWorking(ws)
  const place = picked
    ? { label: 'You chose', path: picked.path, why: 'You chose this place yourself.' }
    : proposal?.state === 'proposed' && current
      ? { label: 'Proposed place', path: proposal.path ?? '', why: `Why: ${proposal.why}` }
      : null

  const decide = async (c: SaveWhereChoice) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const r = await onDecide(c)
      if (r && r.error) setError(r.error)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!purpose || !canSave(ws)) return
    const dest = picked
      ? { ownerId: picked.ownerId, folderId: picked.folderId, newFolderName: picked.newFolderName }
      : { ownerId: proposal!.ownerId!, folderId: proposal!.folderId!, newFolderName: proposal!.newFolderName ?? null }
    void decide({ mode: 'save', purpose, ...dest, fileName: name, proposalOf: picked ? null : { accountId: company && company !== 'business' ? company.accountId : null, business: company === 'business' } })
  }

  return (
    <RequiredDialog labelledBy="save-where-title">
      <div>
        <h3 id="save-where-title" className="text-lg font-semibold text-zinc-900 sm:text-xl">Where should this fax be saved?</h3>
        <p className="mt-1 text-sm text-zinc-600">This window stays open until you choose. The fax goes out whatever you choose.</p>
      </div>

      <div>
        <label htmlFor="sw-name" className="mb-1 block text-xs font-semibold text-zinc-600">File name (change it here if you want)</label>
        <input
          id="sw-name" type="text" data-1p-ignore autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy}
          className="h-11 w-full rounded-md border border-zinc-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <fieldset disabled={busy}>
        <legend className="mb-1 text-xs font-semibold text-zinc-600">{purposeQuestion}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {purposes.map((p) => (
            <label key={p.key} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${purpose === p.key ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-zinc-300 hover:bg-zinc-50'}`}>
              <input type="radio" name="sw-purpose" checked={purpose === p.key} onChange={() => { setPurpose(p.key); setCompany(null); setQuery('') }} />
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>

      {needsCompany && (
        <div>
          <label htmlFor="sw-company" className="mb-1 block text-xs font-semibold text-zinc-600">Which company?</label>
          {company ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium">{company === 'business' ? 'Business (not a client)' : company.name}</span>
              <button type="button" disabled={busy} onClick={() => { setCompany(null); setQuery('') }} className="text-sm font-medium text-blue-700 hover:underline">Change company</button>
            </div>
          ) : (
            <div className="space-y-1">
              <input
                id="sw-company" type="text" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" data-1p-ignore
                placeholder="Type the company name"
                className="h-11 w-full rounded-md border border-zinc-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <ul className="max-h-44 overflow-y-auto rounded-md border border-zinc-200 empty:hidden">
                {hits.map((h) => (
                  <li key={h.accountId}>
                    <button type="button" onClick={() => { setCompany({ accountId: h.accountId, name: h.name }); setHits([]) }} className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50">
                      <span className="truncate">{h.name}</span>
                      {h.status && <span className="shrink-0 text-xs text-zinc-500">{h.status}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setCompany('business')} className="text-sm font-medium text-blue-700 hover:underline">Business (not a client)</button>
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border-2 border-blue-600 p-3 sm:p-4" aria-live="polite">
        {!purpose ? (
          <p className="text-sm text-zinc-600">Choose what this fax is, and the place is proposed here.</p>
        ) : working ? (
          <p className="flex items-center gap-2 text-sm text-zinc-600"><Loader2 className="h-4 w-4 animate-spin" /> Working out the place…</p>
        ) : place ? (
          <>
            <span className="text-xs font-bold uppercase tracking-wide text-blue-700">{place.label}</span>
            <p className="break-words text-base font-semibold text-zinc-900 sm:text-lg">{place.path}</p>
            <p className="text-sm text-zinc-600">{place.why}</p>
            {picked && proposal?.state === 'proposed' && (
              <button type="button" disabled={busy} onClick={() => setPicked(null)} className="mt-2 text-sm font-medium text-blue-700 hover:underline">Back to the proposal</button>
            )}
            {!picked && proposal?.documentType === 'irs_fax' && <p className="mt-2 text-sm text-zinc-600">Document type <span className="ml-1 rounded border border-zinc-300 px-2 py-0.5 font-medium">IRS Fax</span></p>}
          </>
        ) : (
          <>
            <span className="text-xs font-bold uppercase tracking-wide text-blue-700">{proposal?.state === 'refused' ? 'This place can’t take it' : 'Choose a place'}</span>
            <p className="text-sm text-zinc-700">{proposal?.why ?? 'Use Change place to choose where it goes.'}</p>
          </>
        )}
      </div>

      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <button type="button" disabled={busy} onClick={() => void decide({ mode: 'dont_save' })} className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-50">
          {skipLabel}
        </button>
        <button ref={changeBtn} type="button" disabled={busy || !purpose} onClick={() => setPicking(true)} className="min-h-11 rounded-md border border-blue-600 bg-white px-4 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">
          Change place
        </button>
        <button type="button" disabled={!canSave(ws)} onClick={save} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? 'Sending…' : saveLabel}
        </button>
      </div>

      {/* inside the window, so the page-behind lock and the focus trap cover it too */}
      {picking && (
        <FolderPicker
          title="Pick the place" mode="file" chooseOwner allowNewFolder
          onPick={(folderId, ownerId, path, newFolderName) => { setPicked({ ownerId, folderId, newFolderName: newFolderName ?? null, path }); setPicking(false); setError(null); setTimeout(() => changeBtn.current?.focus(), 0) }}
          onClose={() => { setPicking(false); setTimeout(() => changeBtn.current?.focus(), 0) }}
        />
      )}
    </RequiredDialog>
  )
}
