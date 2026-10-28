'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { uploadDocument } from '@/components/marketing/documents-upload'
import { makeT } from '@/lib/marketing/i18n'

interface Listing { crumbs: Array<{ id: string; name: string }>; files: Array<{ id: string; name: string; updatedAt: string }> }
const t = makeT('en')
const SHOWN = 5

/**
 * The Documents card on Antonio's Home (TD Marketing, dev job 9aec66fa, Addendum H): the five newest files of the team's Marketing folder with their download link, and an Upload button that puts files
 * straight in that folder (same upload as the Documents screen). English: his own screen.
 */
export function HomeDocuments() {
  const [data, setData] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const pick = useRef<HTMLInputElement>(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/marketing/documents')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : 'The documents could not be loaded.')
      setData(d as Listing)
    } catch (e) { setError(e instanceof Error ? e.message : 'The documents could not be loaded.') }
  }, [])
  useEffect(() => { void load() }, [load])
  const here = data?.crumbs[data.crumbs.length - 1]?.id ?? null
  async function upload(files: File[]) {
    if (!here || files.length === 0) return
    setBusy(true); setError(null); setNotice(null)
    try { const done: string[] = []; for (const f of files) done.push(await uploadDocument(f, here, null, t)); await load(); setNotice(done.join(' ')) }
    catch (e) { setError(e instanceof Error && e.message ? e.message : 'Upload failed. Please try again.') } finally { setBusy(false) }
  }
  const newest = [...(data?.files ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, SHOWN)
  return (
    <section className="rounded-xl border bg-white p-5" aria-label="Documents" data-testid="home-documents">
      <h2 className="text-sm font-semibold text-slate-600">Documents · newest</h2>
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="home-docs-error">{error}</p>}
      {data && newest.length === 0 && <p className="mt-2 text-sm text-slate-500">No documents yet.</p>}
      <ul className="mt-2 divide-y text-sm">
        {newest.map(f => (
          <li key={f.id} className="flex items-center justify-between gap-3 py-2" data-testid="home-doc">
            <a className="min-w-0 truncate underline" href={`/api/marketing/documents/file/${f.id}`}>{f.name}</a>
            <span className="shrink-0 text-xs text-slate-500">{new Date(f.updatedAt).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Rome' })}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={pick} type="file" multiple className="hidden" data-testid="home-docs-input" onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
        <button type="button" className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !here} onClick={() => pick.current?.click()} data-testid="home-docs-upload">{busy ? 'Uploading…' : 'Upload'}</button>
        <Link href="/marketing/documents" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50" data-testid="home-docs-open">Open Documents</Link>
      </div>
      {notice && <p role="status" className="mt-2 text-xs text-emerald-700" data-testid="home-docs-notice">{notice}</p>}
    </section>
  )
}
