'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare, Pencil, Save, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface LeadNotesEditorProps {
  leadId: string
  notes: string
}

export function LeadNotesEditor({ leadId, notes }: LeadNotesEditorProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(notes)
  const [isPending, startTransition] = useTransition()
  // The text this person is editing FROM, sent with the save so the server refuses (instead of
  // silently overwriting the WHOLE notes) if someone else saved them meanwhile (dev job f3f3e237
  // / d26b8a7e). Captured when editing starts; moved forward after this person's own save.
  const editBase = useRef(notes)
  // When a save is refused because someone else saved first: their version, shown next to what was typed.
  const [conflict, setConflict] = useState<string | null>(null)

  const handleSave = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/update-lead-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId, notes: value, expected_notes: editBase.current }),
        })

        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toast.error(data.error || 'Failed to save notes')
          if (res.status === 409) {
            // Keep what they typed (nothing is lost) and SHOW the other person's version. The next Save
            // is then a deliberate overwrite, so the base moves to what is saved now.
            if (typeof data.current_value === 'string') {
              editBase.current = data.current_value
              setConflict(data.current_value)
            }
            router.refresh()
          }
          return
        }

        editBase.current = value
        toast.success('Notes saved')
        setConflict(null)
        setEditing(false)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  const handleCancel = () => {
    setValue(notes)
    setConflict(null)
    setEditing(false)
  }

  return (
    <div className="bg-white rounded-lg border p-5 md:col-span-2">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          Notes
        </h2>
        {!editing ? (
          <button
            onClick={() => { setValue(notes); editBase.current = notes; setConflict(null); setEditing(true) }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        ) : (
          <div className="flex gap-1.5">
            <button
              onClick={handleSave}
              disabled={isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
            <button
              onClick={handleCancel}
              disabled={isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border text-zinc-600 rounded hover:bg-zinc-50 disabled:opacity-50 transition-colors"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        )}
      </div>

      {editing && conflict !== null && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">Someone else saved these notes while you were editing.</p>
          <p className="mt-0.5 text-xs text-amber-800">
            Their version is below. Your text is kept. Saving now replaces their version with yours.
          </p>
          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2 font-sans text-xs text-zinc-700">{conflict || '(empty)'}</pre>
          <button
            onClick={() => { setValue(conflict); setConflict(null) }}
            className="mt-2 text-xs font-medium text-amber-900 underline"
          >
            Use their version instead
          </button>
        </div>
      )}

      {editing ? (
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          rows={16}
          autoFocus
          className="w-full px-4 py-3 text-sm font-sans leading-relaxed border rounded-lg bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-lg bg-zinc-50 p-4">
          {notes ? (
            <pre className="text-sm text-zinc-700 whitespace-pre-wrap font-sans leading-relaxed">
              {notes}
            </pre>
          ) : (
            <p className="text-sm text-zinc-400 italic">No notes yet. Click Edit to add.</p>
          )}
        </div>
      )}
    </div>
  )
}
