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
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { useCapture } from '@/components/captures/capture-provider'
import { MyCapturesPanel } from '@/components/captures/my-captures-panel'
import { CAPTURE_TOOL_IGNORE_ATTR } from '@/lib/captures/render'

export default function MyCapturesOverlay() {
  const { isBrowseOpen, closeBrowse, openWithFile } = useCapture()
  const [dragOver, setDragOver] = useState(false)
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
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/30 p-4"
      onClick={closeBrowse}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-zinc-900">My Captures</p>
            <p className="text-xs text-zinc-500">Every screenshot you have taken — only visible to you. Drop a picture here to start a new capture with it.</p>
          </div>
          <button onClick={closeBrowse} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100" aria-label="Close">
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
