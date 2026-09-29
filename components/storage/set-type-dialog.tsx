'use client'

/**
 * "Set type" — give a file in the new storage its document type, or correct a wrong one (job 685467b5). The server
 * decides every rule; when it needs an answer (whose document? which company? is it the filed copy?) it asks, and
 * this box shows the question — nothing changed until it is answered.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, X } from 'lucide-react'

export interface StoreDocType { slug: string; name: string; personal: boolean; staffOnly: boolean; defaultFolderKind: string | null; draftNeverVisible: boolean }

type Question =
  | { kind: 'person'; typeName: string; people: Array<{ contactId: string; name: string }> }
  | { kind: 'company'; typeName: string; personName: string; companies: Array<{ ownerId: string; name: string }>; clientSees: boolean }
  | { kind: 'filed'; typeName: string }

/** The storage's document types (shared cache: the row labels and this box read the same list). */
export function useStoreDocTypes() {
  return useQuery<StoreDocType[]>({
    queryKey: ['crm-store-doc-types'],
    queryFn: async () => {
      const r = await fetch('/api/crm-store/browse/types')
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not load the document types.')
      return (j as { types: StoreDocType[] }).types
    },
    staleTime: 60_000,
  })
}

export function SetTypeDialog({ file, viewingOwnerId, onClose, onDone }: {
  file: { id: string; name: string; documentType: string | null }
  viewingOwnerId?: string | null
  onClose: () => void
  onDone: () => void
}) {
  const { data: types, error: typesError } = useStoreDocTypes()
  const [filter, setFilter] = useState('')
  const [slug, setSlug] = useState<string>(file.documentType ?? '')
  const [question, setQuestion] = useState<Question | null>(null)
  const [choice, setChoice] = useState<string>('')
  // every answer given so far (a type can need two: whose passport, then "is it the filed copy?")
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { setQuestion(null); setChoice(''); setAnswers({}) }, [slug])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (types ?? []).filter((t) => !f || t.name.toLowerCase().includes(f))
  }, [types, filter])
  const current = (types ?? []).find((t) => t.slug === file.documentType)

  const submit = async () => {
    if (!slug) return
    const given = { ...answers }
    if (question?.kind === 'person') given.personContactId = choice
    if (question?.kind === 'company') given.companyOwnerId = choice
    if (question?.kind === 'filed') given.filedAnswer = choice
    setAnswers(given)
    const body: Record<string, unknown> = { type: slug, viewingOwnerId: viewingOwnerId ?? null, ...given }
    setBusy(true)
    try {
      const r = await fetch(`/api/crm-store/browse/file/${file.id}/type`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (r.status === 409 && (j as { question?: Question }).question) {
        const q = (j as { question: Question }).question
        setQuestion(q)
        setChoice(q.kind === 'person' && q.people.length === 1 ? q.people[0].contactId : '')
        return
      }
      if (!r.ok) throw new Error((j as { error?: string }).error || 'The type could not be set — please try again.')
      const res = j as { typeName: string; movedTo: string | null; notes: string[] }
      toast.success(`"${file.name}" is now ${res.typeName}${res.movedTo ? ` — moved to ${res.movedTo}` : ''}`)
      for (const n of res.notes ?? []) toast.message(n)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The type could not be set — please try again.')
    } finally { setBusy(false) }
  }

  const radio = (value: string, label: string) => (
    <label key={value} className="flex items-center gap-2 py-0.5">
      <input type="radio" name="set-type-answer" checked={choice === value} onChange={() => setChoice(value)} />
      <span>{label}</span>
    </label>
  )

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="Set document type">
      <div className="w-full max-w-md rounded-lg bg-white p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-zinc-900">{file.documentType ? 'Change type' : 'Set type'}</p>
            <p className="truncate text-xs text-zinc-500">{file.name} · now: {current?.name ?? (file.documentType ? file.documentType : 'no type')}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        {typesError && <p className="text-xs text-red-700">{typesError instanceof Error ? typesError.message : 'Could not load the document types.'}</p>}
        {!types && !typesError && <p className="text-xs text-zinc-500">Loading…</p>}
        {types && (
          <>
            <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search types…"
              className="mb-2 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm" />
            <select size={8} value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Document type"
              className="w-full rounded-md border border-zinc-300 px-1 py-1 text-sm">
              {shown.map((t) => <option key={t.slug} value={t.slug}>{t.name}{t.personal ? ' (personal)' : ''}{t.staffOnly ? ' (staff only)' : ''}</option>)}
            </select>
          </>
        )}
        {question && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-zinc-800">
            {question.kind === 'person' && (
              <>
                <p className="mb-1 font-medium">{question.typeName} is a personal document — whose is it? It moves to that person&apos;s own storage (it still shows in the company&apos;s &quot;2. Contacts&quot;).</p>
                {question.people.length === 0 ? <p className="text-red-700">This company has no people linked — link the person to the company first.</p> : question.people.map((p) => radio(p.contactId, p.name))}
              </>
            )}
            {question.kind === 'company' && (
              <>
                <p className="mb-1 font-medium">{question.typeName} is a company document, and it is in {question.personName}&apos;s own storage. Move it to the company?</p>
                {question.clientSees && <p className="mb-1 text-red-700">The client can see this file: once it is in a company, every member of that company sees it.</p>}
                {question.companies.map((c) => radio(c.ownerId, `Move it to ${c.name}`))}
                {radio('keep', `Keep it in ${question.personName}'s storage`)}
              </>
            )}
            {question.kind === 'filed' && (
              <>
                <p className="mb-1 font-medium">The client can see this file today. Is it the filed return?</p>
                {radio('filed', 'Yes — it is the filed copy (it stays visible and is frozen)')}
                {radio('hide', 'No — hide it from the client until it is filed')}
              </>
            )}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-50">Cancel</button>
          <button type="button" disabled={busy || !slug || (!!question && !choice)} onClick={() => void submit()}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{question ? 'Confirm' : slug === file.documentType ? 'Save again' : 'Save type'}
          </button>
        </div>
      </div>
    </div>
  )
}
