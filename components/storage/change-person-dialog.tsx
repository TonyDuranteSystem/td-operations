'use client'

/**
 * "Belongs to another person" — a personal document filed under the wrong person moves into the right person's own storage.
 * Only people of the same company are offered; the server re-checks everything. Nothing changes until "Move" is pressed.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, X } from 'lucide-react'

export function ChangePersonDialog({ file, onClose, onDone }: {
  file: { id: string; name: string; personName: string | null }
  onClose: () => void
  onDone: () => void
}) {
  const [people, setPeople] = useState<Array<{ contactId: string; name: string }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/crm-store/browse/file/${file.id}/person`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not load the people.')
        if (live) setPeople((j as { people: Array<{ contactId: string; name: string }> }).people)
      })
      .catch((e) => { if (live) setError(e instanceof Error && e.message ? e.message : 'Could not load the people.') })
    return () => { live = false }
  }, [file.id])

  const submit = async () => {
    if (!choice) return
    setBusy(true)
    try {
      const r = await fetch(`/api/crm-store/browse/file/${file.id}/person`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId: choice }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'The file could not be moved — please try again.')
      toast.success(`"${file.name}" now belongs to ${(j as { person: string }).person}`)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The file could not be moved — please try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="Belongs to another person">
      <div className="w-full max-w-md rounded-lg bg-white p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-zinc-900">Whose document is this?</p>
            <p className="truncate text-xs text-zinc-500">{file.name}{file.personName ? ` · now in ${file.personName}'s storage` : ''}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        {error && <p className="text-xs text-red-700">{error}</p>}
        {!people && !error && <p className="text-xs text-zinc-500">Loading…</p>}
        {people && people.length === 0 && <p className="text-xs text-zinc-600">No other person is linked to this person&apos;s companies.</p>}
        {people && people.length > 0 && (
          <div className="rounded-md border border-zinc-200 p-2">
            {people.map((p) => (
              <label key={p.contactId} className="flex items-center gap-2 py-0.5">
                <input type="radio" name="change-person" checked={choice === p.contactId} onChange={() => setChoice(p.contactId)} />
                <span>Move it to {p.name}</span>
              </label>
            ))}
            <p className="mt-1 text-[11px] text-zinc-500">It moves into that person&apos;s own storage (it still shows in the company&apos;s &quot;2. Contacts&quot;).</p>
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-50">Cancel</button>
          <button type="button" disabled={busy || !choice} onClick={() => void submit()}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Move
          </button>
        </div>
      </div>
    </div>
  )
}
