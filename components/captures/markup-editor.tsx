'use client'

/**
 * The mark-up tool: draw / arrow / text / a redact tool that is always
 * genuinely destructive. Drawing happens DIRECTLY on the same canvas that
 * gets exported — there is no separate movable "annotation layer" sitting on
 * top of the picture, so once something is drawn (redaction included) the
 * pixels underneath it are gone from that point on, not just visually
 * covered. A second, transient canvas sits on top only to show a live
 * preview of an in-progress arrow/redact box while dragging; it is cleared
 * and never exported — only the base canvas is.
 *
 * Real undo: before each committed stroke/shape, the base canvas's current
 * pixels are snapshotted; undo restores the previous snapshot. Not just a
 * full Clear — see UX review, 2026-09-04 ("undo is closer to a hard
 * requirement than a nice-to-have with five tools on a touchscreen").
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, ArrowUpRight, Type, EyeOff, Undo2 } from 'lucide-react'
import { MARKUP_TOOLS, arrowHeadPoints, type MarkupTool } from '@/lib/captures/markup'
import { rectFromTwoPoints, type Point } from '@/lib/captures/selection'

const TOOL_META: Record<MarkupTool, { label: string; icon: typeof Pencil }> = {
  draw: { label: 'Draw', icon: Pencil },
  arrow: { label: 'Arrow', icon: ArrowUpRight },
  text: { label: 'Text', icon: Type },
  redact: { label: 'Black out', icon: EyeOff },
}

const DRAW_COLOR = '#f43f5e' // amber/red, visible against most screenshots
const DRAW_WIDTH = 4

function getCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
}

export function MarkupEditor({
  imageFile,
  note,
  onNoteChange,
  onCancel,
  onDone,
}: {
  imageFile: File
  note: string
  onNoteChange: (note: string) => void
  onCancel: () => void
  onDone: (file: File) => void
}) {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<MarkupTool>('draw')
  const [canUndo, setCanUndo] = useState(false)
  const undoStackRef = useRef<string[]>([])
  const strokePointRef = useRef<Point | null>(null)
  const dragStartRef = useRef<Point | null>(null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(false)

  // Load the captured image onto the base canvas, at its real pixel size —
  // drawing/exporting always happens at full resolution, never the shrunk
  // on-screen display size.
  //
  // onerror is a backstop, not the primary guard (bug-hunter finding,
  // 2026-09-04) — the real fix is upstream, rejecting non-image files before
  // they ever reach this component. This still matters for a file that DOES
  // claim to be an image but isn't a valid one (corrupt bytes, a renamed
  // file): without it, onload simply never fires, `ready` stays false
  // forever with no error shown, and Continue/Retake stayed clickable
  // regardless — Continue would then export whatever was already on the
  // untouched, default-sized canvas as a blank, real, SENDABLE picture.
  //
  // `cancelled` guards BOTH callbacks against a STALE image from a
  // SUPERSEDED effect run (found live, 2026-09-05, testing against a
  // development build specifically — the exact class of bug this codebase's
  // Strict Mode double-invoke traps exist to catch, and why local dev is
  // tested, not just production deploys): Strict Mode's dev-only
  // double-invoke tears down the first effect run's Image immediately,
  // revoking its blob URL before that Image has actually decoded. If that
  // torn-down Image's `onerror` fires LATE — after the second, real
  // invocation's Image has already loaded successfully and set ready=true —
  // it would set loadError=true on top of a genuinely successful load,
  // visibly showing the correct picture while leaving Continue disabled for
  // a reason the user can't see. Checking `cancelled` (set true the instant
  // THIS run's own cleanup fires) means only the CURRENT attempt's callbacks
  // can ever change state.
  useEffect(() => {
    const canvas = baseCanvasRef.current
    const preview = previewCanvasRef.current
    if (!canvas || !preview) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let cancelled = false
    setReady(false)
    setLoadError(false)
    const url = URL.createObjectURL(imageFile)
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      preview.width = img.naturalWidth
      preview.height = img.naturalHeight
      ctx.drawImage(img, 0, 0)
      setReady(true)
    }
    img.onerror = () => {
      if (cancelled) return
      setLoadError(true)
    }
    img.src = url
    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
    }
  }, [imageFile])

  const pushUndoSnapshot = useCallback(() => {
    const canvas = baseCanvasRef.current
    if (!canvas) return
    undoStackRef.current.push(canvas.toDataURL('image/png'))
    setCanUndo(true)
  }, [])

  const handleUndo = useCallback(() => {
    const canvas = baseCanvasRef.current
    const ctx = canvas?.getContext('2d')
    const snapshot = undoStackRef.current.pop()
    if (!canvas || !ctx || !snapshot) return
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
    }
    img.src = snapshot
    setCanUndo(undoStackRef.current.length > 0)
  }, [])

  const clearPreview = useCallback(() => {
    const preview = previewCanvasRef.current
    const ctx = preview?.getContext('2d')
    if (preview && ctx) ctx.clearRect(0, 0, preview.width, preview.height)
  }, [])

  const commitArrow = useCallback((from: Point, to: Point) => {
    const ctx = baseCanvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.strokeStyle = DRAW_COLOR
    ctx.fillStyle = DRAW_COLOR
    ctx.lineWidth = DRAW_WIDTH
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    const [left, right] = arrowHeadPoints(from, to)
    ctx.beginPath()
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(left.x, left.y)
    ctx.lineTo(right.x, right.y)
    ctx.closePath()
    ctx.fill()
  }, [])

  const commitRedact = useCallback((from: Point, to: Point) => {
    const canvas = baseCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const rect = rectFromTwoPoints(from, to, { width: canvas.width, height: canvas.height })
    // Solid, opaque fill directly into the base canvas's own pixels — this IS
    // the destructive redaction, not a shape sitting on top of one.
    ctx.fillStyle = '#000000'
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  }, [])

  const previewArrow = useCallback((from: Point, to: Point) => {
    const preview = previewCanvasRef.current
    const ctx = preview?.getContext('2d')
    if (!preview || !ctx) return
    ctx.clearRect(0, 0, preview.width, preview.height)
    ctx.strokeStyle = DRAW_COLOR
    ctx.lineWidth = DRAW_WIDTH
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.setLineDash([])
  }, [])

  const previewRedact = useCallback((from: Point, to: Point) => {
    const preview = previewCanvasRef.current
    const ctx = preview?.getContext('2d')
    if (!preview || !ctx) return
    const rect = rectFromTwoPoints(from, to, { width: preview.width, height: preview.height })
    ctx.clearRect(0, 0, preview.width, preview.height)
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = baseCanvasRef.current
      if (!canvas) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const point = getCanvasPoint(canvas, e.clientX, e.clientY)

      if (tool === 'text') {
        // eslint-disable-next-line no-alert -- quick/casual tool; a full inline text box is a later polish item
        const text = window.prompt('Label text:')
        if (text && text.trim()) {
          pushUndoSnapshot()
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.fillStyle = DRAW_COLOR
            ctx.font = `${Math.round(canvas.width / 40)}px sans-serif`
            ctx.fillText(text.trim(), point.x, point.y)
          }
        }
        return
      }

      pushUndoSnapshot()
      if (tool === 'draw') {
        strokePointRef.current = point
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.strokeStyle = DRAW_COLOR
          ctx.lineWidth = DRAW_WIDTH
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(point.x, point.y)
        }
      } else {
        dragStartRef.current = point
      }
    },
    [tool, pushUndoSnapshot],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = baseCanvasRef.current
      if (!canvas) return
      const point = getCanvasPoint(canvas, e.clientX, e.clientY)

      if (tool === 'draw' && strokePointRef.current) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.lineTo(point.x, point.y)
          ctx.stroke()
        }
        strokePointRef.current = point
      } else if (tool === 'arrow' && dragStartRef.current) {
        previewArrow(dragStartRef.current, point)
      } else if (tool === 'redact' && dragStartRef.current) {
        previewRedact(dragStartRef.current, point)
      }
    },
    [tool, previewArrow, previewRedact],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = baseCanvasRef.current
      if (!canvas) return
      const point = getCanvasPoint(canvas, e.clientX, e.clientY)

      if (tool === 'draw') {
        strokePointRef.current = null
      } else if (tool === 'arrow' && dragStartRef.current) {
        commitArrow(dragStartRef.current, point)
        dragStartRef.current = null
        clearPreview()
      } else if (tool === 'redact' && dragStartRef.current) {
        commitRedact(dragStartRef.current, point)
        dragStartRef.current = null
        clearPreview()
      }
    },
    [tool, commitArrow, commitRedact, clearPreview],
  )

  const handleDone = useCallback(() => {
    const canvas = baseCanvasRef.current
    if (!canvas || !ready || loadError) return
    canvas.toBlob((blob) => {
      if (!blob) return
      onDone(new File([blob], imageFile.name, { type: 'image/png' }))
    }, 'image/png')
  }, [imageFile.name, onDone, ready, loadError])

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-hidden rounded-md border border-zinc-200 bg-zinc-100" style={{ maxHeight: '45vh' }}>
        <div className="relative" style={{ maxHeight: '45vh', overflow: 'auto' }}>
          <canvas ref={baseCanvasRef} className="block w-full" />
          <canvas
            ref={previewCanvasRef}
            className="absolute left-0 top-0 block w-full touch-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{ cursor: tool === 'text' ? 'text' : 'crosshair' }}
          />
        </div>
        {!ready && !loadError && <div className="p-8 text-center text-sm text-zinc-400">Loading...</div>}
        {loadError && (
          <div className="p-8 text-center text-sm text-red-600">Could not load that picture. Please retake.</div>
        )}
      </div>

      <div className="flex items-center gap-1 overflow-x-auto">
        {MARKUP_TOOLS.map((t) => {
          const meta = TOOL_META[t]
          const Icon = meta.icon
          return (
            <button
              key={t}
              onClick={() => setTool(t)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs whitespace-nowrap ${
                tool === t ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
            </button>
          )
        })}
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-30"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      </div>

      <textarea
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="Add a note (not drawn on the picture)..."
        rows={2}
        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
      />

      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-md border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50">
          Retake
        </button>
        <button
          onClick={handleDone}
          disabled={!ready || loadError}
          className="flex-1 rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
