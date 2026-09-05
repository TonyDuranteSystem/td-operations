'use client'

/**
 * "My Captures" as a popup over whatever page you're on (Antonio, 2026-09-04:
 * "when I click on my pictures I don't want to leave the page where I am but
 * a new page should popup"). Mounted once at the dashboard layout level,
 * next to CaptureLayer, for the same reason — a real navigation would lose
 * your place on whatever page you were working from.
 *
 * Also accepts a dropped picture (Antonio, 2026-09-04: "yes add it," after
 * confirming this popup had no drag-and-drop) — hands the file to
 * CaptureLayer via `openWithFile` rather than loading/validating it here a
 * second time; see CaptureProvider's own doc comment for why.
 *
 * The card itself is movable by its header (Antonio, 2026-09-04: "can the
 * popup page be moved?" / "yes add") — reuses the SAME drag mechanism the
 * sticky-notes pill and the team-chat launcher already use
 * (useDraggableFab/lib/ui/draggable-fab.ts), not a second copy of it, so a
 * future fix to tap-vs-drag or viewport-clamping lands in all three at once.
 * That hook's ref/event types were pinned to a <button> for its first two
 * callers; genericized here (still defaulting to HTMLButtonElement) so this
 * div-based drag handle can reuse it without touching either existing caller.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { useCapture } from '@/components/captures/capture-provider'
import { MyCapturesPanel } from '@/components/captures/my-captures-panel'
import { CAPTURE_TOOL_IGNORE_ATTR } from '@/lib/captures/render'
import { useDraggableFab } from '@/components/ui/use-draggable-fab'

export default function MyCapturesOverlay() {
  const { isBrowseOpen, closeBrowse, openWithFile } = useCapture()
  const [dragOver, setDragOver] = useState(false)
  const { ref, dragProps, style, dragging, hasMoved } = useDraggableFab<HTMLDivElement>('td-fab-pos-my-captures-v1')
  if (!isBrowseOpen) return null

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = Array.from(e.dataTransfer.files ?? [])[0]
    if (file) openWithFile(file)
  }

  return (
    <div
      {...{ [CAPTURE_TOOL_IGNORE_ATTR]: true }}
      className="fixed inset-0 z-[65] bg-black/30"
      onClick={closeBrowse}
    >
      <div
        className={`flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl ${
          hasMoved ? 'fixed' : 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
        }`}
        style={style}
        onClick={(e) => e.stopPropagation()}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
      >
        <div
          ref={ref}
          {...dragProps}
          className="flex cursor-grab touch-none items-center justify-between border-b border-zinc-100 px-5 py-3 select-none active:cursor-grabbing"
        >
          <div>
            <p className="text-sm font-semibold text-zinc-900">My Captures</p>
            <p className="text-xs text-zinc-500">Every screenshot you have taken — only visible to you. Drag this bar to move it; drop a picture here to start a new capture with it.</p>
          </div>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => { if (!dragging) closeBrowse() }}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className={`overflow-y-auto p-5 ${dragOver ? 'bg-amber-50' : ''}`}>
          <MyCapturesPanel />
        </div>
      </div>
    </div>
  )
}
