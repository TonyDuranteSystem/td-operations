'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Pencil, Save, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface CallNotesEditorProps {
  leadId: string
  callNotes: string | null
}

export function CallNotesEditor({ leadId, callNotes }: CallNotesEditorProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(callNotes ?? '')
  const [isPending, startTransition] = useTransition()
  // The text this person is editing FROM (see lead-notes-editor): lets the server refuse a
  // silent overwrite of notes someone else saved meanwhile (dev job f3f3e237 / d26b8a7e).
  const editBase = useRef(callNotes ?? '')

  const handleSave = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/update-lead-field', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId, field: 'call_notes', value, expected_value: editBase.current }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toast.error(data.error || 'Failed to save')
          // Keep what they typed (nothing is lost); refresh so the other person's text shows.
          if (res.status === 409) router.refresh()
          return
        }
        editBase.current = value.trim()
        toast.success('Call notes saved')
        setEditing(false)
        router.refresh()
      } catch {
        toast.error('Failed to save')
      }
    })
  }

  const handleCancel = () => {
    setValue(callNotes ?? '')
    setEditing(false)
  }

  return (
    <div className="mt-4 pt-4 border-t">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <FileText className="h-3 w-3" />
          Staff Call Notes
        </p>
        {!editing ? (
          <button
            onClick={() => { editBase.current = callNotes ?? ''; setEditing(true) }}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors"
          >
            <Pencil className="h-2.5 w-2.5" />
            Edit
          </button>
        ) : (
          <div className="flex gap-1">
            <button
              onClick={handleSave}
              disabled={isPending}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5" />}
              Save
            </button>
            <button
              onClick={handleCancel}
              disabled={isPending}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border text-zinc-500 rounded hover:bg-zinc-50 disabled:opacity-50"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          rows={4}
          autoFocus
          placeholder="Add staff interpretation, corrections, or business context..."
          className="w-full px-3 py-2 text-sm border rounded-lg bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
      ) : callNotes ? (
        <p className="text-sm text-zinc-700 whitespace-pre-wrap">{callNotes}</p>
      ) : (
        <p className="text-xs text-zinc-400 italic">
          No staff notes yet. Click Edit to add your interpretation of the call.
        </p>
      )}
    </div>
  )
}
