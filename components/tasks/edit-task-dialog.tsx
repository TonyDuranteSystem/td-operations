'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TASK_STATUS, TASK_PRIORITY, TASK_CATEGORY } from '@/lib/constants'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { updateTask, getTaskLatestTimestamp } from '@/app/(dashboard)/tasks/actions'
import type { Task } from '@/lib/types'
import type { UpdateTaskInput } from '@/lib/schemas/task'
import { format, parseISO } from 'date-fns'

interface EditTaskDialogProps {
  task: Task
  open: boolean
  onClose: () => void
}

export function EditTaskDialog({ task, open, onClose }: EditTaskDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [title, setTitle] = useState(task.task_title)
  const [description, setDescription] = useState(task.description ?? '')
  const [priority, setPriority] = useState(task.priority)
  const [status, setStatus] = useState(task.status)
  const [category, setCategory] = useState(task.category ?? '')
  const [assignedTo, setAssignedTo] = useState(task.assigned_to)
  const [dueDate, setDueDate] = useState(task.due_date ?? '')
  const [accountId, setAccountId] = useState<string | undefined>(task.account_id ?? undefined)
  const [accountName, setAccountName] = useState<string | undefined>(task.company_name ?? undefined)

  if (!open) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    startTransition(async () => {
      // Always fetch latest timestamp to avoid stale lock after drag-drop
      const freshTs = await getTaskLatestTimestamp(task.id)
      const result = await updateTask({
        id: task.id,
        updated_at: freshTs ?? task.updated_at,
        task_title: title.trim(),
        description: description.trim() || undefined,
        priority: priority as 'Urgent' | 'High' | 'Normal' | 'Low',
        status: status as 'To Do' | 'In Progress' | 'Waiting' | 'Done' | 'Cancelled',
        category: (category || undefined) as UpdateTaskInput['category'],
        assigned_to: assignedTo as 'Antonio' | 'Luca',
        due_date: dueDate || undefined,
        account_id: accountId,
      })

      if (result.success) {
        toast.success('Task updated')
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to update task')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto pointer-events-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Edit Task</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Meta info */}
          <div className="px-6 pt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span>Created: {format(parseISO(task.created_at), 'MMM d, yyyy')}</span>
            {task.company_name && <span>Company: {task.company_name}</span>}
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Title */}
            <div>
              <label className="block text-sm font-medium mb-1">Title *</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                autoFocus
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            {/* Status + Priority (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {TASK_STATUS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={e => setPriority(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {TASK_PRIORITY.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Category + Assigned To (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Category</label>
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">None</option>
                  {TASK_CATEGORY.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Assigned To</label>
                <select
                  value={assignedTo}
                  onChange={e => setAssignedTo(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="Luca">Luca</option>
                  <option value="Antonio">Antonio</option>
                </select>
              </div>
            </div>

            {/* Due Date */}
            <div>
              <label className="block text-sm font-medium mb-1">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Account */}
            <div>
              <label className="block text-sm font-medium mb-1">Account</label>
              <AccountCombobox
                value={accountId}
                displayValue={accountName}
                onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
