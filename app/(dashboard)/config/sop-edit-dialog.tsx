"use client"

import { useState, useTransition } from "react"
import { X, Loader2, Save, Pencil } from "lucide-react"
import { toast } from "sonner"
import { saveSOP } from "./actions"

export interface SOPRow {
  id: string
  title: string
  service_type: string | null
  version: string | null
  notes: string | null
  content: string
  updated_at: string | null
}

export function SOPEditButton({
  row,
  serviceTypes,
}: {
  row: SOPRow
  serviceTypes: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-blue-600 hover:text-blue-800 text-xs inline-flex items-center gap-1"
      >
        <Pencil className="h-3 w-3" /> Edit
      </button>
      {open && (
        <SOPEditDialog
          row={row}
          serviceTypes={serviceTypes}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function SOPEditDialog({
  row,
  serviceTypes,
  onClose,
}: {
  row: SOPRow
  serviceTypes: string[]
  onClose: () => void
}) {
  const [title, setTitle] = useState(row.title)
  const [serviceType, setServiceType] = useState(row.service_type ?? "")
  const [version, setVersion] = useState(row.version ?? "")
  const [notes, setNotes] = useState(row.notes ?? "")
  const [content, setContent] = useState(row.content)
  const [isPending, startTransition] = useTransition()

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const result = await saveSOP(row.id, row.updated_at, {
        title: title.trim(),
        service_type: serviceType || null,
        version: version.trim() || null,
        notes: notes.trim() || null,
        content,
      })
      if (result.success) {
        toast.success("SOP saved")
        onClose()
      } else {
        toast.error(result.error ?? "Save failed")
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <form
        onSubmit={handleSave}
        className="relative bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">Edit SOP</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Service Type</label>
              <select
                value={serviceType}
                onChange={e => setServiceType(e.target.value)}
                className="w-full border rounded-md px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {serviceTypes.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Version</label>
              <input
                type="text"
                value={version}
                onChange={e => setVersion(e.target.value)}
                placeholder="e.g. 7.2"
                className="w-full border rounded-md px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Content (Markdown)</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              required
              rows={16}
              className="w-full border rounded-md px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md border hover:bg-zinc-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 inline-flex items-center gap-1.5"
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
