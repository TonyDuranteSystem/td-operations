'use client'

import { useState } from 'react'
import { ChevronDown, Pin, X } from 'lucide-react'
import { snippet, type TalkMessage } from '@/lib/talk/chat-model'
import { nextPinned } from '@/lib/talk/pins'

/**
 * The bar at the top of a TD Talk chat that shows a pinned message (dev job b719980f). `pins` is already worked out (newest pin first);
 * with several pins the arrow steps through them. Tapping the text jumps to the message, the X unpins it.
 * TD Talk only: the Marketing chat draws its own bar and is not touched by this file.
 */
export function TalkPinnedBar({ pins, meId, onOpen, onUnpin }: {
  pins: TalkMessage[]
  meId: string
  onOpen: (id: string) => void
  onUnpin: (m: TalkMessage) => void
}) {
  const [shownId, setShownId] = useState<string | null>(null)
  const shown = pins.find(p => p.id === shownId) ?? pins[0] ?? null
  if (!shown) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5" data-testid="pinned-bar">
      <Pin className="h-3.5 w-3.5 shrink-0 text-amber-800" />
      <button type="button" onClick={() => onOpen(shown.id)} className="min-w-0 flex-1 text-left" data-testid="pinned-open">
        <span className="block text-[11px] font-semibold text-amber-800" data-testid="pinned-label">
          {pins.length > 1 ? `Pinned message ${pins.indexOf(shown) + 1} of ${pins.length}` : 'Pinned message'} · {shown.sender_id === meId ? 'You' : shown.sender_name}
        </span>
        <span className="block truncate text-[13px] text-zinc-800" data-testid="pinned-text">{snippet(shown, 100)}</span>
      </button>
      <button type="button" onClick={() => onUnpin(shown)} aria-label="Unpin" data-testid="pinned-unpin" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-amber-800 hover:bg-amber-100">
        <X className="h-4 w-4" />
      </button>
      {pins.length > 1 && (
        <button type="button" onClick={() => setShownId(nextPinned(pins, shown.id)?.id ?? null)} aria-label="Next pinned message" data-testid="pinned-next" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-amber-800 hover:bg-amber-100">
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
