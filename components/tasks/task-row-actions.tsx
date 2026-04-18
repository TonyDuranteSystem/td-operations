'use client'

/**
 * P3.9 — row-level action menu for task cards on the Task Kanban.
 *
 * The existing TaskCard exposes quick-actions for Complete / Reassign-toggle
 * / Priority up-down / Edit. This menu adds the remaining gap actions:
 *   • Set status to any value (not just Done via the checkmark)
 *   • Append a dated note
 *   • Delete the task (with P3.7 preview dialog)
 *
 * Uses the same portal + flip-above pattern as PaymentRowActions so the
 * dropdown stays visible even when the card sits near the bottom of the
 * viewport or inside an overflow-clipped Kanban column.
 */

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  MoreVertical,
  Loader2,
  Trash2,
  StickyNote,
  X,
  Circle,
} from 'lucide-react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import {
  updateTaskStatus,
  deleteTask,
  deleteTaskPreview,
  appendTaskNoteAction,
} from '@/app/(dashboard)/tasks/actions'
import { TASK_STATUS } from '@/lib/constants'
import type { Task } from '@/lib/types'

interface Props {
  task: Task
}

export function TaskRowActions({ task }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const positionMenu = () => {
    if (!buttonRef.current) return
    const btn = buttonRef.current.getBoundingClientRect()
    const menuWidth = 208
    const menuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, 260)
    const gap = 4
    const margin = 8

    let top = btn.bottom + gap
    let left = btn.right - menuWidth

    if (top + menuHeight + margin > window.innerHeight) {
      const flippedTop = btn.top - menuHeight - gap
      if (flippedTop >= margin) {
        top = flippedTop
      } else {
        top = Math.max(margin, window.innerHeight - menuHeight - margin)
      }
    }
    if (left + menuWidth + margin > window.innerWidth) {
      left = window.innerWidth - menuWidth - margin
    }
    if (left < margin) left = margin

    setMenuPos({ top, left })
  }

  useLayoutEffect(() => {
    if (!menuOpen) return
    positionMenu()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const handler = () => positionMenu()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler is stable enough
  }, [menuOpen])

  const handleSetStatus = (status: string) => {
    if (status === task.status) { setMenuOpen(false); return }
    setMenuOpen(false)
    startTransition(async () => {
      const result = await updateTaskStatus(task.id, status, task.updated_at)
      if (result.success) {
        toast.success(`Status \u2192 ${status}`)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Failed to update status')
      }
    })
  }

  const handleDeleteConfirm = async () => {
    const result = await deleteTask(task.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: 'Task deleted' }
    }
    return { success: false, error: result.error ?? 'Delete failed' }
  }

  const loadDeletePreview = async () => {
    const r = await deleteTaskPreview(task.id)
    if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
    return r.preview
  }

  const statusDotColor: Record<string, string> = {
    'To Do': 'text-zinc-400',
    'In Progress': 'text-blue-500',
    'Waiting': 'text-amber-500',
    'Done': 'text-emerald-500',
    'Cancelled': 'text-zinc-300',
  }

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' } : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-52 bg-white border rounded-lg shadow-lg overflow-hidden"
          role="menu"
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 bg-zinc-50 border-b">
            Set status
          </div>
          {TASK_STATUS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSetStatus(s)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
            >
              <Circle className={`h-2.5 w-2.5 ${statusDotColor[s] ?? 'text-zinc-300'} fill-current`} />
              {s}
              {s === task.status && <span className="ml-auto text-xs text-zinc-400">current</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setNoteOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left border-t"
          >
            <StickyNote className="h-4 w-4" /> Add note
          </button>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); setDeleteOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-700 hover:bg-red-50 text-left border-t"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
        disabled={isPending}
        className="p-1.5 rounded hover:bg-zinc-100 text-muted-foreground hover:text-zinc-700 disabled:opacity-50"
        title="More actions"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
      </button>
      {menuPortal}

      <ConfirmDestructiveDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Task"
        description={`Delete "${task.task_title}"?`}
        severity="red"
        loadPreview={loadDeletePreview}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
      />

      {noteOpen && (
        <AddNoteDialog
          taskId={task.id}
          taskTitle={task.task_title ?? 'task'}
          updatedAt={task.updated_at}
          onClose={() => setNoteOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  )
}

// ── Add Note Dialog ────────────────────────────────────────

function AddNoteDialog({
  taskId,
  taskTitle,
  updatedAt,
  onClose,
  onSaved,
}: {
  taskId: string
  taskTitle: string
  updatedAt: string
  onClose: () => void
  onSaved: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [note, setNote] = useState('')

  const handleSave = () => {
    const trimmed = note.trim()
    if (!trimmed) {
      toast.error('Note cannot be empty')
      return
    }
    startTransition(async () => {
      const result = await appendTaskNoteAction(taskId, trimmed, updatedAt)
      if (result.success) {
        toast.success('Note added')
        onSaved()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to append note')
      }
    })
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold truncate">
            Add note to {taskTitle}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
            rows={4}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            placeholder="The note is dated automatically and appended above the existing notes."
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-3 py-1.5 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || !note.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Add note
          </button>
        </div>
      </div>
    </div>
  )
}
