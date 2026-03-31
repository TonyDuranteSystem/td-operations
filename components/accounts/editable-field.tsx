'use client'

import { useState, useRef, useEffect } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'

function formatDisplayDate(val: string): string {
  if (!val) return '\u2014'
  try { return format(parseISO(val), 'MMM d, yyyy') } catch { return val }
}

interface EditableFieldProps {
  label: string
  value: string
  icon?: React.ElementType
  type?: 'text' | 'select' | 'date' | 'textarea'
  options?: { label: string; value: string }[]
  readOnly?: boolean
  onSave: (value: string) => Promise<{ success: boolean; error?: string }>
}

/**
 * Generic inline-edit component.
 * Pre-Coding Decision #4: Save/Cancel buttons (not blur-to-save).
 * Shows toast via parent component on success/error.
 */
export function EditableField({
  label,
  value,
  icon: Icon,
  type = 'text',
  options,
  readOnly = false,
  onSave,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(value)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [editing, value])

  const handleSave = async () => {
    if (draft === value) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    const result = await onSave(draft)
    setSaving(false)
    if (result.success) {
      setEditing(false)
    } else {
      setError(result.error ?? 'Failed to save')
    }
  }

  const handleCancel = () => {
    setDraft(value)
    setEditing(false)
    setError(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      handleCancel()
    }
  }

  // View mode
  if (!editing) {
    return (
      <div className="flex items-center gap-2 group">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className="text-muted-foreground min-w-[100px] text-sm">{label}</span>
        <span className="font-medium text-sm flex-1">{type === 'date' ? formatDisplayDate(value) : (value || '\u2014')}</span>
        {!readOnly && (
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-100 transition-opacity"
            title={`Edit ${label}`}
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>
    )
  }

  // Edit mode
  return (
    <div className="flex items-start gap-2">
      {Icon && <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-2.5" />}
      <span className="text-muted-foreground min-w-[100px] text-sm mt-2">{label}</span>
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-1">
          {type === 'select' && options ? (
            <select
              ref={inputRef as React.RefObject<HTMLSelectElement>}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : type === 'textarea' ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              className="flex-1 px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={type}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="p-1.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-600 disabled:opacity-50"
            title="Save"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={handleCancel}
            disabled={saving}
            className="p-1.5 rounded bg-zinc-50 hover:bg-zinc-100 text-zinc-600"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {error && (
          <p className="text-xs text-red-600">{error}</p>
        )}
      </div>
    </div>
  )
}
