"use client"

import { useState, useTransition } from "react"
import { X, Loader2, Save, Pencil } from "lucide-react"
import { toast } from "sonner"
import { saveDevTask } from "./actions"

export interface DevTaskRow {
  id: string
  title: string
  status: string
  priority: string
  type: string
  description: string | null
  decisions: string | null
  blockers: string | null
  updated_at: string | null
}

const STATUS_OPTIONS = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"] as const
const PRIORITY_OPTIONS = ["critical", "high", "medium", "low"] as const
const TYPE_OPTIONS = ["feature", "bugfix", "refactor", "cleanup", "docs", "infra"] as const

export function DevTaskEditButton({ row }: { row: DevTaskRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-blue-600 hover:text-blue-800 text-xs inline-flex items-center gap-1"
      >
        <Pencil className="h-3 w-3" /> Edit
      </button>
      {open && <DevTaskEditDialog row={row} onClose={() => setOpen(false)} />}
    </>
  )
}

function DevTaskEditDialog({ row, onClose }: { row: DevTaskRow; onClose: () => void }) {
  const [title, setTitle] = useState(row.title)
  const [status, setStatus] = useState(row.status)
  const [priority, setPriority] = useState(row.priority)
  const [type, setType] = useState(row.type)
  const [description, setDescription] = useState(row.description ?? "")
  const [decisions, setDecisions] = useState(row.decisions ?? "")
  const [blockers, setBlockers] = useState(row.blockers ?? "")
  const [isPending, startTransition] = useTransition()

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const result = await saveDevTask(row.id, row.updated_at, {
        title: title.trim(),
        status,
        priority,
        type,
        description: description.trim() || null,
        decisions: decisions.trim() || null,
        blockers: blockers.trim() || null,
      })
      if (result.success) {
        toast.success("Dev task saved")
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
        className="relative bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">Edit Dev Task</h2>
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
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)} className="w-full border rounded-md px-3 py-2 text-sm">
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)} className="w-full border rounded-md px-3 py-2 text-sm">
                {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Type</label>
              <select value={type} onChange={e => setType(e.target.value)} className="w-full border rounded-md px-3 py-2 text-sm">
                {TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={4}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Decisions</label>
            <textarea
              value={decisions}
              onChange={e => setDecisions(e.target.value)}
              rows={3}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Blockers</label>
            <textarea
              value={blockers}
              onChange={e => setBlockers(e.target.value)}
              rows={2}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border hover:bg-zinc-100">
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
