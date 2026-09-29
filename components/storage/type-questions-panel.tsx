'use client'

/**
 * Storage → "Type questions" (job 685467b5): the labels CRM records carry that the storage's document types don't
 * know. Each is answered once — "same as <type>", "add as a new type", or "not a type" — and from then on every record
 * with that label (now and later) is recognised. Owners answer; staff can see the list.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Search } from 'lucide-react'
import { useStoreDocTypes } from './set-type-dialog'

interface TypeQuestion { id: string; label: string; records: number; askedAt: string }

const NEW_TYPE_FOLDERS: Array<{ kind: string; label: string }> = [
  { kind: 'company', label: '1. Company' },
  { kind: 'personal', label: "2. Contacts — a person's own document" },
  { kind: 'tax', label: '3. Tax' },
  { kind: 'banking', label: '4. Banking' },
  { kind: 'correspondence', label: '5. Correspondence' },
]

async function post<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || fallback)
  return j as T
}

export function TypeQuestionsPanel() {
  const qc = useQueryClient()
  const { data, error, isLoading } = useQuery<{ questions: TypeQuestion[]; canAnswer: boolean }>({
    queryKey: ['crm-store-type-questions'],
    queryFn: async () => {
      const r = await fetch('/api/crm-store/type-questions')
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not read the questions.')
      return j as { questions: TypeQuestion[]; canAnswer: boolean }
    },
  })
  const { data: types } = useStoreDocTypes()
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [same, setSame] = useState<Record<string, string>>({})
  const [folder, setFolder] = useState<Record<string, string>>({})
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['crm-store-type-questions'] })
    void qc.invalidateQueries({ queryKey: ['crm-store-doc-types'] })
  }

  const scan = async () => {
    setScanning(true)
    try {
      const r = await post<{ asked: number }>('/api/crm-store/type-questions', {}, 'Could not look for unknown labels.')
      toast.success(r.asked ? `${r.asked} new label${r.asked === 1 ? '' : 's'} to answer` : 'No new unknown labels')
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not look for unknown labels.')
    } finally { setScanning(false) }
  }
  const answer = async (q: TypeQuestion, body: Record<string, unknown>, done: string) => {
    setBusy(q.id)
    try {
      await post(`/api/crm-store/type-questions/${q.id}`, body, 'The answer could not be saved.')
      toast.success(done)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The answer could not be saved.')
    } finally { setBusy(null) }
  }

  const canAnswer = !!data?.canAnswer
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-zinc-600">
          Labels on CRM records that the storage&apos;s document types don&apos;t know. Answer each once — every record with that label is then recognised, today and in the future. A label used on a single record is not asked here: give that file its type with <strong>Set type</strong>.
        </p>
        {canAnswer && (
          <button type="button" disabled={scanning} onClick={() => void scan()}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}Look for unknown labels
          </button>
        )}
      </div>
      {!canAnswer && data && <p className="text-xs text-zinc-500">Only the owners answer these.</p>}
      {isLoading && <p className="text-zinc-500">Loading…</p>}
      {error && <p className="text-red-700">{error instanceof Error ? error.message : 'Could not read the questions.'}</p>}
      {data && data.questions.length === 0 && <p className="text-zinc-500">Nothing to answer.</p>}
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        {(data?.questions ?? []).map((q) => (
          <li key={q.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="min-w-[12rem] flex-1">
              <p className="font-medium text-zinc-900">&ldquo;{q.label}&rdquo;</p>
              <p className="text-xs text-zinc-500">on {q.records} record{q.records === 1 ? '' : 's'}</p>
            </div>
            {canAnswer && (
              <>
                <div className="flex items-center gap-1">
                  <select aria-label={`Same as — ${q.label}`} value={same[q.id] ?? ''} onChange={(e) => setSame({ ...same, [q.id]: e.target.value })}
                    className="max-w-[14rem] rounded-md border border-zinc-300 px-1 py-1 text-xs">
                    <option value="">Same as…</option>
                    {(types ?? []).map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
                  </select>
                  <button type="button" disabled={busy === q.id || !same[q.id]}
                    onClick={() => void answer(q, { answer: 'same', type: same[q.id] }, `"${q.label}" now means ${types?.find((t) => t.slug === same[q.id])?.name ?? 'that type'}`)}
                    className="rounded-md bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
                </div>
                <div className="flex items-center gap-1">
                  <select aria-label={`New type folder — ${q.label}`} value={folder[q.id] ?? ''} onChange={(e) => setFolder({ ...folder, [q.id]: e.target.value })}
                    className="max-w-[14rem] rounded-md border border-zinc-300 px-1 py-1 text-xs">
                    <option value="">New type, in folder…</option>
                    {NEW_TYPE_FOLDERS.map((f) => <option key={f.kind} value={f.kind}>{f.label}</option>)}
                  </select>
                  <button type="button" disabled={busy === q.id || !folder[q.id]}
                    onClick={() => void answer(q, { answer: 'new', folderKind: folder[q.id] }, `"${q.label}" added as a new type`)}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50">Add</button>
                </div>
                <button type="button" disabled={busy === q.id}
                  onClick={() => void answer(q, { answer: 'reject' }, `"${q.label}" is not a type — those files are typed one by one`)}
                  className="rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50">Not a type</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
