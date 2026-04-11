'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

interface EditableFieldProps {
  leadId: string
  field: string
  value: string | null
  type?: 'text' | 'select' | 'date'
  options?: Array<{ value: string; label: string }>
  clearable?: boolean
  placeholder?: string
  warning?: string
}

export function EditableField({
  leadId,
  field,
  value,
  type = 'text',
  options,
  clearable = false,
  placeholder,
  warning,
}: EditableFieldProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value ?? '')
  const [isPending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  const handleSave = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/update-lead-field', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId, field, value: editValue }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error || 'Failed to save')
          return
        }
        toast.success('Saved')
        setEditing(false)
        router.refresh()
      } catch {
        toast.error('Failed to save')
      }
    })
  }

  const handleClear = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/update-lead-field', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId, field, value: '' }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error || 'Failed to clear')
          return
        }
        toast.success('Cleared')
        setEditValue('')
        setEditing(false)
        router.refresh()
      } catch {
        toast.error('Failed to clear')
      }
    })
  }

  const handleCancel = () => {
    setEditValue(value ?? '')
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') handleCancel()
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-0">
        {type === 'select' && options ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">—</option>
            {options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={type === 'date' ? 'date' : 'text'}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )}
        <button
          onClick={handleSave}
          disabled={isPending}
          className="p-0.5 text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
          title="Save"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={handleCancel}
          disabled={isPending}
          className="p-0.5 text-zinc-400 hover:text-zinc-600 disabled:opacity-50"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {warning && editing && (
          <span className="text-[10px] text-amber-600 ml-1">{warning}</span>
        )}
      </div>
    )
  }

  const displayValue = type === 'select' && options
    ? options.find(o => o.value === value)?.label || value
    : value

  return (
    <span className="font-medium inline-flex items-center gap-1 group min-w-0">
      <span className="truncate">{displayValue || '\u2014'}</span>
      <button
        onClick={() => { setEditValue(value ?? ''); setEditing(true) }}
        className="p-0.5 text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-zinc-600 transition-opacity"
        title="Edit"
      >
        <Pencil className="h-3 w-3" />
      </button>
      {clearable && value && (
        <button
          onClick={handleClear}
          disabled={isPending}
          className="p-0.5 text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity disabled:opacity-50"
          title="Remove"
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        </button>
      )}
    </span>
  )
}
