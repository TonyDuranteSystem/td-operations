'use client'

/**
 * "Save to Storage" under a client's chat message — the Storage screen itself, in a pop-up (dev job fb49265a; Antonio 2026-11-09:
 * "can I have the same identical card pop-up that I have in storage instead of being limited?").
 *
 * It opens the client's OWN storage (the company; or the person in a person's own thread) with the chat file already in the upload bar, so
 * folder, whose document, type, name, "Show to client", tax year, filed / draft, same file and "a case is waiting for this" are the Storage
 * upload's own questions — nothing is re-built, nothing is chosen for you, and the file is saved only when you press "Upload this file".
 * Nothing is read by Document AI here. A message with several files loads them one after the other.
 *
 * The ITIN card (`save-to-storage-card.tsx`) is the other way: it READS an ITIN letter and fills the person's record. It is one click away.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react'
import { NewStoreBrowser } from '@/components/storage/new-store-browser'
import { CardErrorBoundary } from '@/components/dashboard/card-error-boundary'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import type { HandoffTarget } from '@/lib/crm-store/chat-file-handoff'
import { businessOwnerIdOf, type HandoffArea, type NavGroupLike } from '@/lib/crm-store/handoff-area'

/** Why the ITIN reader exists: Storage's own upload of an "ITIN Letter" fills the person's record from the file and does not check whose letter it is. */
const ITIN_HINT = "Storage fills a person's record from an ITIN letter without checking whose letter it is. The ITIN reader checks the name, the date of birth and the other holders of that ITIN first."

interface SignedFile { url: string; name: string; mimeType: string; size: number | null }

/** R099: show the server's own words when it says why, with a plain fallback. */
async function getJson<T>(url: string, fallback: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((d as { error?: string }).error || fallback)
  return d as T
}

const fmtSize = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function SaveChatFileDialog({ messageId, onClose, onOpenItinCard }: { messageId: string; onClose: () => void; onOpenItinCard: () => void }) {
  const [target, setTarget] = useState<HandoffTarget | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [done, setDone] = useState<Record<number, boolean>>({})
  const [current, setCurrent] = useState<number | null>(null)
  const [incoming, setIncoming] = useState<{ key: string; file: File } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // where this file goes: the client's own storage (default) or the firm's Business folders (Antonio 2026-11-10)
  const [area, setArea] = useState<HandoffArea>('client')
  const [business, setBusiness] = useState<{ state: 'idle' | 'loading' | 'ready' | 'unavailable'; ownerId: string | null; error: string | null }>({ state: 'idle', ownerId: null, error: null })
  const businessAsked = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // the answer of an older click must never land on a newer one
  const seq = useRef(0)

  const files = (target?.items ?? []).filter((i) => !i.voice)

  const loadFile = useCallback(async (index: number) => {
    const mine = ++seq.current
    setCurrent(index); setIncoming(null); setFileError(null); setFetching(true)
    try {
      const signed = await getJson<SignedFile>(`/api/crm-store/save-from-chat/handoff?messageId=${encodeURIComponent(messageId)}&index=${index}`, 'The file could not be prepared — please try again.')
      const res = await fetch(signed.url)
      if (!res.ok) throw new Error('The file could not be fetched from the chat storage — please try again.')
      const blob = await res.blob()
      if (mine !== seq.current) return
      setIncoming({ key: `${messageId}:${index}:${mine}`, file: new File([blob], signed.name, { type: signed.mimeType || blob.type || 'application/octet-stream' }) })
    } catch (e) {
      if (mine === seq.current) setFileError(e instanceof Error && e.message ? e.message : 'The file could not be prepared — please try again.')
    } finally {
      if (mine === seq.current) setFetching(false)
    }
  }, [messageId])

  // whose storage this is + the files; then the first file is loaded
  useEffect(() => {
    let live = true
    setTarget(null); setLoadError(null); setDone({}); setCurrent(null); setIncoming(null)
    getJson<HandoffTarget>(`/api/crm-store/save-from-chat/handoff?messageId=${encodeURIComponent(messageId)}`, 'Could not open the files — please try again.')
      .then((t) => {
        if (!live) return
        setTarget(t)
        const first = t.items.find((i) => !i.voice)
        if (first) void loadFile(first.index)
      })
      .catch((e) => { if (live) setLoadError(e instanceof Error && e.message ? e.message : 'Could not open the files — please try again.') })
    return () => { live = false }
  }, [messageId, loadFile])

  useEffect(() => { rootRef.current?.focus() }, [target])

  // The Business owner is looked up once, the first time Business is chosen (the navigation lists only what this login may open).
  useEffect(() => {
    if (area !== 'business' || businessAsked.current) return
    businessAsked.current = true
    setBusiness({ state: 'loading', ownerId: null, error: null })
    getJson<{ groups: NavGroupLike[] }>('/api/crm-store/browse/navigation', 'Could not open the Business folders — please try again.')
      .then((d) => {
        const id = businessOwnerIdOf(d.groups)
        setBusiness(id ? { state: 'ready', ownerId: id, error: null } : { state: 'unavailable', ownerId: null, error: 'The Business folders are not offered to your login.' })
      })
      .catch((e) => {
        businessAsked.current = false // a failed lookup may be tried again by choosing Business again
        setBusiness({ state: 'unavailable', ownerId: null, error: e instanceof Error && e.message ? e.message : 'Could not open the Business folders — please try again.' })
      })
  }, [area])

  // No Escape-to-close on purpose: the Storage screen inside has its own question windows, and Escape must only ever close the one in front.

  const onSaved = useCallback((key: string) => {
    const idx = Number(key.split(':')[1])
    setDone((d) => ({ ...d, [idx]: true }))
    setIncoming(null)
    const next = (target?.items ?? []).find((i) => !i.voice && i.index !== idx && !done[i.index])
    if (next) void loadFile(next.index)
  }, [target, done, loadFile])

  const title = target?.label ? `Save to Storage — ${target.label}` : 'Save to Storage'
  const allDone = files.length > 0 && files.every((f) => done[f.index])

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Save to Storage" data-testid="save-chat-file-dialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && !fetching && !Object.values(done).some(Boolean)) onClose() }}>
      <div ref={rootRef} tabIndex={-1} className="flex max-h-[94vh] w-full max-w-6xl flex-col rounded-xl bg-zinc-50 shadow-xl outline-none">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-zinc-900">{title}</h3>
            <p className="text-xs text-zinc-500">{area === 'business'
              ? 'Open the Business folder where this file goes, then press “Upload this file into …”. The file also stays in the chat.'
              : 'The chat file is in the upload bar below. Choose the folder, the type and whether the client sees it, then press “Upload this file”. The file also stays in the chat.'}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <FastTooltip label={ITIN_HINT}>
              <button type="button" onClick={onOpenItinCard} disabled={busy || fetching} aria-label={`ITIN letter? Use the ITIN reader. ${ITIN_HINT}`} className="text-xs text-blue-700 hover:underline disabled:opacity-40" data-testid="save-chat-file-itin">ITIN letter? Use the ITIN reader (it checks whose it is)</button>
            </FastTooltip>
            <button type="button" onClick={onClose} disabled={busy || fetching} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40" data-testid="save-chat-file-close"><X className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!target && !loadError && <p className="flex items-center gap-2 text-sm text-zinc-600" data-testid="save-chat-file-loading"><Loader2 className="h-4 w-4 animate-spin" /> Opening the client&apos;s storage…</p>}
          {loadError && <p className="flex gap-1.5 rounded bg-red-50 p-3 text-sm text-red-700" data-testid="save-chat-file-load-error"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {loadError}</p>}

          {target && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="save-chat-file-area">
                <span className="text-zinc-500">Save in:</span>
                {(['client', 'business'] as const).map((a) => (
                  <button key={a} type="button" disabled={busy || fetching} aria-pressed={area === a} onClick={() => setArea(a)}
                    className={`rounded-md border px-2.5 py-1 font-medium ${area === a ? 'border-blue-400 bg-blue-50 text-blue-900' : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'} disabled:opacity-60`}
                    data-testid={`save-chat-file-area-${a}`}>{a === 'client' ? (target.label ?? (target.scope === 'company' ? 'This company' : 'This person')) : 'Business'}</button>
                ))}
              </div>
              {files.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="save-chat-file-list">
                  <span className="text-zinc-500">Files in this message:</span>
                  {files.map((f) => (
                    <button key={f.index} type="button" disabled={busy || fetching || done[f.index]} onClick={() => void loadFile(f.index)}
                      className={`inline-flex max-w-[16rem] items-center gap-1 rounded-md border px-2 py-1 ${current === f.index ? 'border-blue-400 bg-blue-50 text-blue-900' : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'} disabled:opacity-60`}
                      data-testid={`save-chat-file-pick-${f.index}`}>
                      {done[f.index] ? <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" /> : null}
                      <span className="truncate">{f.name}</span>
                      {f.size != null && <span className="shrink-0 text-zinc-400">{fmtSize(f.size)}</span>}
                    </button>
                  ))}
                </div>
              )}
              {target.moreThanListed && <p className="text-xs text-amber-800">Only the first files of this message are listed here.</p>}
              {fetching && <p className="flex items-center gap-2 text-sm text-zinc-600" data-testid="save-chat-file-fetching"><Loader2 className="h-4 w-4 animate-spin" /> Getting the file from the chat…</p>}
              {fileError && <p className="flex gap-1.5 rounded bg-red-50 p-3 text-sm text-red-700" data-testid="save-chat-file-error"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {fileError}</p>}
              {allDone && !incoming && <p className="flex items-center gap-1.5 rounded bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="save-chat-file-all-done"><CheckCircle2 className="h-4 w-4 shrink-0" /> {files.length === 1 ? 'The file is saved in Storage.' : 'All the files of this message are saved in Storage.'} You can close this window.</p>}

              {area === 'client' && !target.ownerId && (
                <p className="rounded bg-amber-50 p-3 text-sm text-amber-900" data-testid="save-chat-file-no-storage">
                  {target.scope === 'company' ? `${target.label ?? 'This company'} has no storage yet` : `${target.label ?? 'This person'} has no storage of their own yet`}, so there is nowhere to save this file under them from here. Nothing was saved or created. You can still save it in Business.
                </p>
              )}
              {area === 'client' && target.ownerId && (
                <CardErrorBoundary key={target.ownerId} fallbackTitle="Storage">
                  <NewStoreBrowser ownerId={target.ownerId} scopedKind={target.scope === 'person' ? 'person' : 'company'} incomingFile={incoming} onIncomingSaved={onSaved} onBusyChange={setBusy} />
                </CardErrorBoundary>
              )}

              {area === 'business' && business.state === 'loading' && <p className="flex items-center gap-2 text-sm text-zinc-600" data-testid="save-chat-file-business-loading"><Loader2 className="h-4 w-4 animate-spin" /> Opening the Business folders…</p>}
              {area === 'business' && business.state === 'unavailable' && <p className="flex gap-1.5 rounded bg-amber-50 p-3 text-sm text-amber-900" data-testid="save-chat-file-business-unavailable"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {business.error}</p>}
              {area === 'business' && business.state === 'ready' && business.ownerId && (
                <>
                  <p className="text-xs text-zinc-500" data-testid="save-chat-file-business-hint">Business has no document type and no client: click the folder where the file goes, then press “Upload this file into …”.</p>
                  <CardErrorBoundary key={business.ownerId} fallbackTitle="Business">
                    <NewStoreBrowser ownerId={business.ownerId} scopedKind="business" incomingFile={incoming} onIncomingSaved={onSaved} onBusyChange={setBusy} />
                  </CardErrorBoundary>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-zinc-200 bg-white px-4 py-3">
          <button type="button" onClick={onClose} disabled={busy || fetching} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50" data-testid="save-chat-file-done">{Object.values(done).some(Boolean) ? 'Done' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}
