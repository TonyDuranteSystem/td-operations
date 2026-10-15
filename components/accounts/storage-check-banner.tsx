'use client'

/**
 * Storage check — the banner on a company page and the pop-up it opens (dev job ad09ea91). Shows what the CRM and the
 * company's storage disagree about; staff tick what to do and press Apply, say "Not an issue", or decide later.
 * Phase 1 only tells and does the harmless things; it never ends anyone's access and never sends an email.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileSearch, FolderCog, Loader2, X } from 'lucide-react'
import { STORAGE_CHECK_EVENT, takeStorageCheckWish } from '@/lib/crm-store/storage-check-events'

interface FindingAction { id: string; label: string; defaultOn: boolean }
interface FindingView { key: string; kind: string; title: string; detail: string; actions: FindingAction[]; blocked?: string | null; openFileId?: string | null }
interface CheckResponse { inStorage: boolean; findings: FindingView[]; results?: Array<{ key: string; action: string; ok: boolean; message: string }> }

export function StorageCheckBanner({ accountId }: { accountId: string }) {
  const [data, setData] = useState<CheckResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const wanted = useRef(false)

  const load = useCallback(async (opts: { fromSave?: boolean } = {}) => {
    try {
      const r = await fetch(`/api/accounts/${accountId}/storage-check`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not check the storage.')
      const res = j as CheckResponse
      setData(res)
      setTicked((prev) => {
        const next: Record<string, boolean> = {}
        for (const f of res.findings) for (const a of f.actions) next[`${f.key}|${a.id}`] = prev[`${f.key}|${a.id}`] ?? (a.defaultOn && !f.blocked)
        return next
      })
      // a save just happened and the check found something: open the pop-up right away
      if ((opts.fromSave || wanted.current) && res.findings.length > 0) setOpen(true)
      wanted.current = false
    } catch {
      /* the banner is a help, never an error on the company page */
    }
  }, [accountId])

  useEffect(() => {
    wanted.current = takeStorageCheckWish()
    void load()
    const onSaved = () => { wanted.current = true; window.setTimeout(() => { void load({ fromSave: true }) }, 600) }
    window.addEventListener(STORAGE_CHECK_EVENT, onSaved)
    return () => window.removeEventListener(STORAGE_CHECK_EVENT, onSaved)
  }, [load])

  const findings = data?.findings ?? []
  if (!data || !data.inStorage || findings.length === 0) return null

  const apply = async () => {
    const apply: Array<{ key: string; action: string }> = []
    for (const f of findings) for (const a of f.actions) if (ticked[`${f.key}|${a.id}`]) apply.push({ key: f.key, action: a.id })
    if (apply.length === 0) { toast.message('Nothing is ticked.'); return }
    setBusy(true)
    try {
      const r = await fetch(`/api/accounts/${accountId}/storage-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'That could not be done — please try again.')
      const res = j as CheckResponse
      for (const x of res.results ?? []) { if (x.ok) toast.success(x.message); else toast.error(x.message) }
      setData(res)
      if (res.findings.length === 0) setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'That could not be done — please try again.')
    } finally { setBusy(false) }
  }

  const dismiss = async (key: string) => {
    setBusy(true)
    try {
      const r = await fetch(`/api/accounts/${accountId}/storage-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dismiss: key }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'That could not be saved.')
      const res = j as CheckResponse
      setData(res)
      if (res.findings.length === 0) setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'That could not be saved.')
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="storage-check-banner">
        <FolderCog className="h-4 w-4 shrink-0" />
        <span className="flex-1">Storage check: {findings.length} {findings.length === 1 ? 'thing' : 'things'} to look at</span>
        <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs hover:bg-amber-100">Review</button>
      </div>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Storage check">
          <div className="flex max-h-[88vh] w-full max-w-xl flex-col rounded-xl bg-white p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-start gap-2">
              <FolderCog className="mt-0.5 h-5 w-5 text-blue-700" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-zinc-900">Storage check</p>
                <p className="text-xs text-zinc-500">What the CRM and this company&apos;s storage disagree about. Nothing happens until you press Apply.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
            </div>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {findings.map((f) => (
                <li key={f.key} className="rounded-md border border-zinc-200 p-2.5">
                  <p className="font-medium text-zinc-900">{f.title}</p>
                  <p className="mt-0.5 text-xs text-zinc-600">{f.detail}</p>
                  {f.blocked && <p className="mt-1 text-xs text-amber-700">{f.blocked}</p>}
                  {f.openFileId && (
                    <a href={`/api/crm-store/browse/file/${f.openFileId}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline">
                      <FileSearch className="h-3.5 w-3.5" />Open the file to check
                    </a>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {f.actions.map((a) => (
                      <label key={a.id} className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox" disabled={!!f.blocked} checked={!!ticked[`${f.key}|${a.id}`]} onChange={(e) => setTicked((t) => ({ ...t, [`${f.key}|${a.id}`]: e.target.checked }))} />
                        <span>{a.label}</span>
                      </label>
                    ))}
                    <button type="button" disabled={busy} onClick={() => void dismiss(f.key)} className="ml-auto text-xs text-zinc-500 hover:underline">Not an issue</button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-zinc-500">Nothing here moves a person&apos;s documents unless you tick it, and nothing ends anyone&apos;s access or sends an email.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-50">Decide later</button>
              <button type="button" disabled={busy} onClick={() => void apply()} className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
