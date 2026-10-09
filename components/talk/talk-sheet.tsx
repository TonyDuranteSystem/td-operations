'use client'

import { useState } from 'react'
import { Copy, CornerUpLeft, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { REACTION_EMOJIS, canDelete, canEdit, reactionSummary, snippet, type TalkMessage } from '@/lib/talk/chat-model'

/**
 * The message menu (long-press a message, or right-click on a computer): quick reactions, Reply, Copy, Edit and Delete
 * (the last two only on my own messages). Delete asks once more. It is a bottom sheet so it is easy to reach with a thumb.
 */
export function TalkMessageSheet({
  message, meId, onClose, onReact, onReply, onCopy, onEdit, onDelete,
}: {
  message: TalkMessage
  meId: string
  onClose: () => void
  onReact: (emoji: string) => void
  onReply: () => void
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const mine = reactionSummary(message.reactions, meId).filter(p => p.mine).map(p => p.emoji)
  const hasText = !!(message.message ?? '').trim()

  const Row = ({ icon, label, onClick, danger = false, testId }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; testId?: string }) => (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn('flex w-full items-center gap-4 px-5 py-3.5 text-left text-[16px] active:bg-zinc-100', danger ? 'text-red-600' : 'text-zinc-900')}
    >
      <span className="text-zinc-500">{icon}</span>{label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" data-testid="talk-sheet" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative rounded-t-2xl bg-white pb-[max(env(safe-area-inset-bottom),12px)] shadow-xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-zinc-300" />
        <p className="truncate px-5 pb-1 pt-3 text-xs text-zinc-400">{snippet(message, 60)}</p>
        {confirming ? (
          <div className="px-5 pb-3 pt-1">
            <p className="mb-3 text-[16px] text-zinc-900">Delete this message for everyone?</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirming(false)} className="flex-1 rounded-xl border border-zinc-200 py-3 text-[16px] text-zinc-800 active:bg-zinc-50">Cancel</button>
              <button type="button" onClick={onDelete} data-testid="talk-delete-confirm" className="flex-1 rounded-xl bg-red-600 py-3 text-[16px] font-semibold text-white active:opacity-80">Delete</button>
            </div>
          </div>
        ) : (
          <>
            {!message.deleted_at && (
              <div className="flex justify-between gap-1 px-4 py-2">
                {REACTION_EMOJIS.map(e => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => onReact(e)}
                    aria-label={`React ${e}`}
                    data-testid={`talk-react-${e}`}
                    className={cn('flex h-12 w-12 items-center justify-center rounded-full text-2xl active:bg-zinc-100', mine.includes(e) && 'bg-zinc-200')}
                  >{e}</button>
                ))}
              </div>
            )}
            {!message.deleted_at && <Row icon={<CornerUpLeft className="h-5 w-5" />} label="Reply" onClick={onReply} testId="talk-act-reply" />}
            {hasText && !message.deleted_at && <Row icon={<Copy className="h-5 w-5" />} label="Copy text" onClick={onCopy} testId="talk-act-copy" />}
            {canEdit(message, meId) && <Row icon={<Pencil className="h-5 w-5" />} label="Edit" onClick={onEdit} testId="talk-act-edit" />}
            {canDelete(message, meId) && <Row icon={<Trash2 className="h-5 w-5" />} label="Delete" onClick={() => setConfirming(true)} danger testId="talk-act-delete" />}
          </>
        )}
      </div>
    </div>
  )
}
