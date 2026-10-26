'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, FileText, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ContractDialog } from './contract-dialog'
import { loadContract, request, sourceLabel, type ContractPayload } from './contract-api'

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''

const nameOf = (email: string | null | undefined) =>
  (email ?? '').split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

/**
 * The "Contract" card on a service's page (screen 1): where this service's contract stands — none, a draft waiting for
 * approval, or approved — and the button for the next step. Services that use one of the built-in contracts, or a
 * contract type the system does not recognise, say so instead. Opens the Contract pop-up for everything else.
 */
export function ContractCard({
  entryId,
  contractTypeInBox,
  onContractType,
}: {
  /** The service's id; null while the service has not been created yet. */
  entryId: string | null
  /** What the "Contract type" box on this page currently holds. */
  contractTypeInBox: string
  /** The service got its own contract type — the box (and a later Save) must carry it. */
  onContractType: (type: string) => void
}) {
  const [view, setView] = useState<ContractPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [writing, setWriting] = useState(false)
  const [startingNew, setStartingNew] = useState(false)

  // The page re-renders on every keystroke; the card must NOT ask the server again each time. The two values that change
  // are read through refs, and the reading effect depends on the service only.
  const boxRef = useRef(contractTypeInBox)
  const notifyRef = useRef(onContractType)
  boxRef.current = contractTypeInBox
  notifyRef.current = onContractType
  const latest = useRef(0)

  const refresh = useCallback(async () => {
    if (!entryId) return
    const mine = ++latest.current
    try {
      const data = await loadContract(entryId)
      if (mine !== latest.current) return // an older answer must never overwrite a newer one
      setView(data)
      setError(null)
      if (data.contractType && data.contractType.startsWith('custom_') && data.contractType !== boxRef.current) notifyRef.current(data.contractType)
    } catch (e) {
      if (mine !== latest.current) return
      setError(e instanceof Error ? e.message : 'Could not read the contract.')
    }
  }, [entryId])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#contract') document.getElementById('contract')?.scrollIntoView({ block: 'start' })
  }, [])

  const draftWithClaude = async () => {
    if (!entryId) return
    setWriting(true)
    try {
      await request(`/api/service-contracts/${entryId}/draft`, { method: 'POST', body: { mode: 'claude' } })
      await refresh()
      setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Claude could not write the contract.', { id: 'contract-draft-error' })
      // the draft may have been saved even though the answer never arrived: show what is really there
      await refresh()
    } finally {
      setWriting(false)
    }
  }

  const startNewVersion = async () => {
    if (!entryId) return
    setStartingNew(true)
    try {
      await request(`/api/service-contracts/${entryId}/draft`, { method: 'POST', body: { mode: 'from_approved' } })
      await refresh()
      setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start a new version.', { id: 'contract-newversion-error' })
      await refresh()
    } finally {
      setStartingNew(false)
    }
  }

  const approved = view?.versions.find((v) => v.status === 'approved') ?? null
  const draft = view?.versions.find((v) => v.status === 'draft') ?? null

  return (
    <section id="contract" className="mb-4 bg-white border rounded-lg" data-contract-card>
      <header className="px-4 py-3 border-b bg-zinc-50">
        <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5"><FileText className="h-4 w-4" />Contract</h2>
        <p className="text-xs text-zinc-500 mt-0.5">The agreement the client signs for this service.</p>
      </header>
      <div className="p-4 space-y-3 text-sm">
        {!entryId ? (
          <p className="text-zinc-600">Save the service first. Then its contract can be created here.</p>
        ) : error ? (
          <p className="flex items-start gap-2 text-red-700"><AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>
        ) : !view ? (
          <p className="flex items-center gap-2 text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Reading the contract…</p>
        ) : view.kind !== 'new' ? (
          <p className={view.kind === 'other' ? 'flex items-start gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2' : 'text-zinc-700'} data-contract-note>
            {view.kind === 'other' && <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
            <span>{view.note}</span>
          </p>
        ) : view.state === 'none' ? (
          <>
            <p className="text-zinc-800"><strong>No contract yet.</strong> Offers with this service cannot be sent until it has one.</p>
            <p className="text-xs text-zinc-500">Claude writes the draft from the saved service: its name, description and steps. Save your changes above first. You read it, and an owner approves it.</p>
            <button type="button" onClick={draftWithClaude} disabled={writing || !view.aiConfigured} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50" data-draft-with-claude>
              {writing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {writing ? 'Claude is writing the contract…' : 'Draft with Claude'}
            </button>
            {writing && <p className="text-xs text-zinc-500">This takes up to a minute. Please stay on this page.</p>}
            {!view.aiConfigured && <p className="text-xs text-zinc-500">Claude is not set up on this server, so this button is off.</p>}
          </>
        ) : (
          <>
            {approved ? (
              <p className="flex items-start gap-2 text-zinc-800">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
                <span><strong>Approved — version {approved.version}.</strong> Approved by {nameOf(approved.approvedBy)} on {fmtDate(approved.approvedAt)}. Sent with {approved.offersSent} offer{approved.offersSent === 1 ? '' : 's'} so far.</span>
              </p>
            ) : null}
            {draft ? (
              <p className="text-zinc-800">
                <strong>{approved ? `Version ${draft.version} is a draft` : `Draft ${draft.version}`} — waiting for approval.</strong>{' '}
                {sourceLabel(draft).charAt(0).toUpperCase() + sourceLabel(draft).slice(1)} on {fmtDate(draft.createdAt)}.
                {!approved && ' Offers with this service still cannot be sent.'}
              </p>
            ) : null}
            <div className="flex gap-2 flex-wrap">
              {draft && (
                <button type="button" onClick={() => setOpen(true)} className="px-3 py-2 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700" data-review-contract>Review &amp; approve</button>
              )}
              {approved && !draft && (
                <>
                  <button type="button" onClick={() => setOpen(true)} className="px-3 py-2 rounded-md border border-zinc-300 text-zinc-800 hover:bg-zinc-50" data-view-contract>View</button>
                  <button type="button" onClick={startNewVersion} disabled={startingNew} className="px-3 py-2 rounded-md border border-zinc-300 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 inline-flex items-center gap-1.5" data-new-version-card>
                    {startingNew && <Loader2 className="h-3.5 w-3.5 animate-spin" />}New version
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {open && entryId && <ContractDialog entryId={entryId} onClose={() => { setOpen(false); void refresh() }} onChanged={() => { void refresh() }} />}
    </section>
  )
}
