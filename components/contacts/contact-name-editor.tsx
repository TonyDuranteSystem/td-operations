'use client'

import { useState } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { cleanNamePart } from '@/lib/contacts/contact-name'

interface ContactNameEditorProps {
  firstName: string | null
  lastName: string | null
  fullName: string
  /** Saves first + last together (the full name is built from them on the server). */
  onSave: (firstName: string, lastName: string) => Promise<{ success: boolean; error?: string }>
}

/**
 * The contact's name at the top of the contact page: the full name as the title, edited as TWO fields (first name, last name) so the first
 * and last name stored on the contact can never drift from the full name shown here.
 */
export function ContactNameEditor({ firstName, lastName, fullName, onSave }: ContactNameEditorProps) {
  const [editing, setEditing] = useState(false)
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEditing = () => {
    // A contact saved before first/last existed has only a full name: offer it split at the first space, for the person to confirm.
    const f = cleanNamePart(firstName)
    const l = cleanNamePart(lastName)
    if (f || l) { setFirst(f); setLast(l) } else {
      const [head, ...rest] = cleanNamePart(fullName).split(' ')
      setFirst(head ?? ''); setLast(rest.join(' '))
    }
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const result = await onSave(first, last)
    setSaving(false)
    if (result.success) setEditing(false)
    else setError(result.error ?? 'Failed to save')
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void save() }
    if (e.key === 'Escape') setEditing(false)
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 group">
        <span className="text-2xl font-bold">{fullName || '—'}</span>
        <FastTooltip label="Edit name">
          <button
            onClick={startEditing}
            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-100 transition-opacity"
            aria-label="Edit name"
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
        </FastTooltip>
      </div>
    )
  }

  const inputCls = 'text-sm border rounded px-2 py-1.5 w-44 bg-background'
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          aria-label="First name"
          placeholder="First name"
          className={inputCls}
          value={first}
          onChange={e => setFirst(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <input
          aria-label="Last name"
          placeholder="Last name"
          className={inputCls}
          value={last}
          onChange={e => setLast(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button onClick={save} disabled={saving} className="p-1.5 rounded hover:bg-green-50 text-green-600" aria-label="Save name">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} className="p-1.5 rounded hover:bg-red-50 text-red-600" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
