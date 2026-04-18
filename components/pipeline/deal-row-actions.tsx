'use client'

/**
 * P3.9 — row-level action menu for deal cards on /pipeline.
 *
 * DealCard handles drag-drop for stage changes in kanban view and
 * click-to-edit everywhere. This menu adds explicit stage selection
 * (some users prefer clicks over drag), Add note, and Delete — with a
 * preview that shows linked service delivery count and blocks deletion
 * of Closed Won / Paid deals for audit-trail protection.
 *
 * Same portal + flip-above pattern as the rest of the P3.9 row menus.
 */

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  MoreVertical,
  Loader2,
  Trash2,
  Circle,
  StickyNote,
  X,
} from 'lucide-react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import {
  updateDealStage,
  deleteDeal,
  deleteDealPreview,
  addDealNote,
} from '@/app/(dashboard)/pipeline/actions'

const DEAL_STAGES = [
  'Initial Consultation',
  'Offer Sent',
  'Negotiation',
  'Agreement Signed',
  'Paid',
  'Closed Won',
  'Closed Lost',
] as const

const STAGE_DOT: Record<string, string> = {
  'Initial Consultation': 'text-zinc-400',
  'Offer Sent': 'text-amber-500',
  'Negotiation': 'text-blue-500',
  'Agreement Signed': 'text-indigo-500',
  'Paid': 'text-teal-500',
  'Closed Won': 'text-emerald-500',
  'Closed Lost': 'text-red-400',
}

export interface DealRowData {
  id: string
  deal_name: string
  stage: string | null
  updated_at: string
}

interface Props {
  deal: DealRowData
}

export function DealRowActions({ deal }: Props) {
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
    const menuWidth = 220
    const menuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, 320)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler stable enough
  }, [menuOpen])

  const handleSetStage = (stage: string) => {
    if (stage === deal.stage) { setMenuOpen(false); return }
    setMenuOpen(false)
    startTransition(async () => {
      try {
        await updateDealStage(deal.id, stage)
        toast.success(`Stage \u2192 ${stage}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update stage')
      }
    })
  }

  const handleDeleteConfirm = async () => {
    const result = await deleteDeal(deal.id)
    if (result.success) {
      router.refresh()
      return { success: true, message: 'Deal deleted' }
    }
    return { success: false, error: result.error ?? 'Delete failed' }
  }

  const loadDeletePreview = async () => {
    const r = await deleteDealPreview(deal.id)
    if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
    return r.preview
  }

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' } : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-[220px] bg-white border rounded-lg shadow-lg overflow-hidden max-h-[70vh] overflow-y-auto"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 bg-zinc-50 border-b sticky top-0">
            Set stage
          </div>
          {DEAL_STAGES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSetStage(s)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
            >
              <Circle className={`h-2.5 w-2.5 shrink-0 ${STAGE_DOT[s] ?? 'text-zinc-300'} fill-current`} />
              <span className="flex-1 truncate">{s}</span>
              {s === deal.stage && <span className="text-[10px] text-zinc-400 shrink-0">current</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setNoteOpen(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left border-t"
          >
            <StickyNote className="h-4 w-4" /> Add note
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDeleteOpen(true) }}
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
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o) }}
        disabled={isPending}
        className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
        title="More actions"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
      </button>
      {menuPortal}

      <ConfirmDestructiveDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Deal"
        description={`Delete "${deal.deal_name}"?`}
        severity="red"
        loadPreview={loadDeletePreview}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
      />

      {noteOpen && (
        <AddNoteDialog
          dealId={deal.id}
          dealName={deal.deal_name}
          updatedAt={deal.updated_at}
          onClose={() => setNoteOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  )
}

function AddNoteDialog({
  dealId,
  dealName,
  updatedAt,
  onClose,
  onSaved,
}: {
  dealId: string
  dealName: string
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
      const result = await addDealNote(dealId, trimmed, updatedAt)
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
          <h2 className="text-sm font-semibold truncate">Add note to {dealName}</h2>
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
            placeholder="Dated automatically. Appended above existing notes."
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
