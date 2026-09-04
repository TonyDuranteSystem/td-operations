'use client'

/**
 * CaptureLayer — the actual Capture/Share tool. Mounted ONCE at the dashboard
 * layout level, outside <main>, next to StickyNotesLayer/FloatingChat, so it
 * survives page navigation (Antonio, 2026-09-04: "the screenshot page must
 * stay open if I move in different page to send it") the exact same way those
 * two already do. Mounting outside <main> is necessary but was NOT
 * sufficient by itself: past every stage except "selecting", the panel is
 * deliberately rendered WITHOUT a full-screen backdrop, because a backdrop
 * sitting above the sidebar silently swallows every click there — verified
 * live, 2026-09-04, that this made a tap meant to navigate just close the
 * tool instead, defeating the requirement even though the component itself
 * never unmounted. Docking the panel at the bottom without covering the
 * rest of the screen is what actually keeps the sidebar clickable while a
 * capture is in progress.
 *
 * Stage machine: mode -> selecting -> capturing -> markup -> uploading ->
 * destination -> done. A picture can also enter straight at "markup",
 * skipping capture entirely, via paste (global, while this is open) or
 * dragging a file onto the mode panel — both reuse the same MarkupEditor and
 * the same upload engine as a fresh capture, never a separate path (Antonio,
 * 2026-09-04: paste + drag are both "just include them now", not separate
 * features). "Retake" returns to mode from markup; closing at any point
 * resets state.
 *
 * "destination" (steps 5+6) first offers a choice — a sticky note, or a
 * specific Team Chat conversation — then renders the matching picker. Team
 * Chat's picker delivers through the real human send route (identity, push,
 * mentions all real), never the AI's own posting choke-point, which always
 * stamps the sender as Claude — wrong for a person sharing their own
 * screenshot. Exactly one destination per share, never both at once
 * (Antonio, confirmed earlier: single destination, not a broadcast).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Crop, Loader2, MessageSquare, Send, StickyNote, X } from 'lucide-react'
import { useCapture } from '@/components/captures/capture-provider'
import { captureWholePage, captureRegion, canvasToPngFile, generateCaptureTitle, CAPTURE_TOOL_IGNORE_ATTR } from '@/lib/captures/render'
import { rectFromTwoPoints, isSelectionLargeEnough, type Point, type CaptureRect } from '@/lib/captures/selection'
import { uploadCapture } from '@/lib/captures/upload'
import { validateChatAttachment } from '@/lib/portal/chat-attachment'
import { MarkupEditor } from '@/components/captures/markup-editor'
import { NoteDestinationPicker } from '@/components/captures/note-destination-picker'
import { TeamChatDestinationPicker } from '@/components/captures/team-chat-destination-picker'
import { PortalChatDestinationPicker } from '@/components/captures/portal-chat-destination-picker'
import { attachCaptureToNote, sendCaptureToTeamChat } from '@/lib/captures/share-actions'
import { getRecentDestinations, addRecentDestination, REQUIRES_CONFIRMATION, type RecentDestination } from '@/lib/captures/recent-destinations'

type Stage = 'mode' | 'selecting' | 'capturing' | 'markup' | 'uploading' | 'destination' | 'done' | 'error'
type DestinationChoice = 'sticky_note' | 'team_chat' | 'portal_chat' | null
type PortalChatPrefill = { contactId: string; accountId: string | null; label: string }

export default function CaptureLayer() {
  const { isOpen, close } = useCapture()
  const [stage, setStage] = useState<Stage>('mode')
  const [firstPoint, setFirstPoint] = useState<Point | null>(null)
  const [livePoint, setLivePoint] = useState<Point | null>(null)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [uploadedCaptureId, setUploadedCaptureId] = useState<string | null>(null)
  const [destinationChoice, setDestinationChoice] = useState<DestinationChoice>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentDestination[]>([])
  const [quickSending, setQuickSending] = useState(false)
  const [doneMessage, setDoneMessage] = useState<string | null>(null)
  const [portalChatPrefill, setPortalChatPrefill] = useState<PortalChatPrefill | null>(null)

  const reset = useCallback(() => {
    setStage('mode')
    setFirstPoint(null)
    setLivePoint(null)
    setCapturedFile(null)
    setNote('')
    setUploadedCaptureId(null)
    setDestinationChoice(null)
    setErrorMessage(null)
    setQuickSending(false)
    setDoneMessage(null)
    setPortalChatPrefill(null)
  }, [])

  const handleClose = useCallback(() => {
    reset()
    close()
  }, [reset, close])

  // Reset every time it's freshly opened, so a leftover preview from a
  // previous capture never lingers into a new one.
  useEffect(() => {
    if (isOpen) reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const runCapture = useCallback(async (fn: () => Promise<HTMLCanvasElement>) => {
    setStage('capturing')
    try {
      const canvas = await fn()
      const file = await canvasToPngFile(canvas, `capture-${Date.now()}.png`)
      setCapturedFile(file)
      setStage('markup')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not capture that. Please try again.')
      setStage('error')
    }
  }, [])

  /** Entry point for a picture that did NOT come from a fresh capture —
   *  pasted from the clipboard, or dropped onto the mode panel. Skips
   *  straight to markup, reusing the exact same editor and upload engine. */
  const loadExternalFile = useCallback((file: File) => {
    const validationError = validateChatAttachment(file.name, file.size, file.type)
    if (validationError) {
      setErrorMessage(validationError)
      setStage('error')
      return
    }
    setCapturedFile(file)
    setStage('markup')
  }, [])

  // Paste support (Antonio, 2026-09-04): while the tool is open, pasting an
  // already-copied picture loads it straight into the same mark-up editor —
  // reuses the identical clipboard-file interception pattern already proven
  // in the team-chat and worker composers, not a new gesture invented here.
  useEffect(() => {
    if (!isOpen || stage !== 'mode') return
    const handlePaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) loadExternalFile(file)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [isOpen, stage, loadExternalFile])

  const handleWholePage = useCallback(() => {
    void runCapture(captureWholePage)
  }, [runCapture])

  const handleSelectArea = useCallback(() => {
    setFirstPoint(null)
    setLivePoint(null)
    setStage('selecting')
  }, [])

  const finishSelection = useCallback(
    (rect: CaptureRect) => {
      void runCapture(() => captureRegion(rect))
    },
    [runCapture],
  )

  const handleOverlayPoint = useCallback(
    (point: Point) => {
      if (!firstPoint) {
        setFirstPoint(point)
        setLivePoint(point)
        return
      }
      const rect = rectFromTwoPoints(firstPoint, point, {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      })
      if (!isSelectionLargeEnough(rect)) {
        // Too small to be deliberate — treat as a fresh first tap instead of
        // silently failing.
        setFirstPoint(point)
        setLivePoint(point)
        return
      }
      finishSelection(rect)
    },
    [firstPoint, finishSelection],
  )

  const handleRetake = useCallback(() => {
    setCapturedFile(null)
    setNote('')
    setStage('mode')
  }, [])

  const handleMarkupDone = useCallback(
    async (finalFile: File) => {
      setStage('uploading')
      setErrorMessage(null)
      try {
        const capture = await uploadCapture({ file: finalFile, title: generateCaptureTitle(), note })
        setUploadedCaptureId(capture.id)
        // Loaded fresh on arrival at the destination step, not once at open —
        // a share completed earlier in this SAME session (recent-then-retake)
        // must already be reflected in the shortcut list.
        setRecents(getRecentDestinations())
        setStage('destination')
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not save the capture. Please try again.')
        setStage('error')
      }
    },
    [note],
  )

  const handleAttached = useCallback(
    (message?: string) => {
      setDoneMessage(message ?? null)
      setStage('done')
      setTimeout(handleClose, 1200)
    },
    [handleClose],
  )

  const handleDestinationError = useCallback((message: string) => {
    setErrorMessage(message)
    setStage('error')
  }, [])

  // Step 8 — one tap on a remembered destination does exactly what picking
  // it from the full picker does: the same request, the same "move to
  // front" bump, the same success/failure handling. The one exception is a
  // destination REQUIRES_CONFIRMATION marks true (today: only portal_chat,
  // the client-facing one) — a quick-tap there pre-fills the picker with
  // this exact target instead of sending, so it still lands on the same
  // mandatory confirmation screen a fresh search would. Consulting the map
  // here, rather than hardcoding which types skip confirmation, is
  // deliberate: the natural way to wire a new type into this function is a
  // same-shaped extra branch, which is exactly how an earlier draft of this
  // change would have silently instant-sent the one destination that must
  // never skip confirmation (bug-hunter finding, council pass 2026-09-04).
  const handleQuickSend = useCallback(
    async (dest: RecentDestination) => {
      if (!uploadedCaptureId) return
      if (REQUIRES_CONFIRMATION[dest.type]) {
        if (dest.type === 'portal_chat') {
          setPortalChatPrefill({ contactId: dest.contactId, accountId: dest.accountId, label: dest.label })
          setDestinationChoice('portal_chat')
        }
        return
      }
      setQuickSending(true)
      setErrorMessage(null)
      try {
        if (dest.type === 'sticky_note') {
          await attachCaptureToNote(uploadedCaptureId, dest.id)
        } else if (dest.type === 'team_chat') {
          await sendCaptureToTeamChat(uploadedCaptureId, dest.id)
        }
        addRecentDestination(dest)
        handleAttached()
      } catch (err) {
        setQuickSending(false)
        setErrorMessage(err instanceof Error ? err.message : 'Could not send it there. Please try again.')
        setStage('error')
      }
    },
    [uploadedCaptureId, handleAttached],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = Array.from(e.dataTransfer.files ?? [])[0]
      if (file) loadExternalFile(file)
    },
    [loadExternalFile],
  )

  if (!isOpen) return null

  return (
    <>
      {stage === 'selecting' && (
        <SelectionOverlay
          firstPoint={firstPoint}
          livePoint={livePoint}
          onPoint={handleOverlayPoint}
          onMove={setLivePoint}
          onCancel={() => setStage('mode')}
        />
      )}

      {stage !== 'selecting' && (
        // Deliberately NOT a full-screen backdrop (no dimming, no
        // click-outside-to-close): Antonio, 2026-09-04, "the screenshot page
        // must stay open if I move in different page to send it" — verified
        // live that a full backdrop silently defeated this, since it sits
        // above the sidebar and swallows every click there, so a tap meant
        // to navigate just closed the tool instead of ever reaching a link.
        // This docks the panel at the bottom without covering the rest of
        // the screen, so the sidebar and page content underneath stay fully
        // clickable — closing is the X button only, never an accidental
        // outside tap (also cheaper insurance against losing a picture you
        // already spent time marking up).
        <div {...{ [CAPTURE_TOOL_IGNORE_ATTR]: true }} className="fixed inset-x-0 bottom-0 z-[55] flex justify-center px-0 sm:px-4 sm:pb-4">
          <div
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-xl border border-zinc-200 bg-white p-4 shadow-2xl sm:max-w-md sm:rounded-xl"
            onDrop={stage === 'mode' ? handleDrop : undefined}
            onDragOver={stage === 'mode' ? (e) => e.preventDefault() : undefined}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">Capture</span>
              <button onClick={handleClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {stage === 'mode' && (
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleSelectArea}
                  className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
                >
                  <Crop className="h-4 w-4 text-zinc-500" />
                  Select an area of the page
                </button>
                <button
                  onClick={handleWholePage}
                  className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
                >
                  <Camera className="h-4 w-4 text-zinc-500" />
                  Capture the whole page
                </button>
                <p className="pt-1 text-center text-xs text-zinc-400">or paste / drop a picture here</p>
              </div>
            )}

            {stage === 'capturing' && (
              <div className="flex flex-col items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-6 w-6 animate-spin" />
                Capturing...
              </div>
            )}

            {stage === 'markup' && capturedFile && (
              <MarkupEditor
                imageFile={capturedFile}
                note={note}
                onNoteChange={setNote}
                onCancel={handleRetake}
                onDone={(finalFile) => void handleMarkupDone(finalFile)}
              />
            )}

            {stage === 'uploading' && (
              <div className="flex flex-col items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-6 w-6 animate-spin" />
                Saving...
              </div>
            )}

            {stage === 'destination' && uploadedCaptureId && destinationChoice === null && (
              <div className="flex flex-col gap-3">
                {recents.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-zinc-400">Send to the same place again:</p>
                    <div className="flex flex-col gap-1">
                      {recents.map((r) => {
                        const Icon = r.type === 'sticky_note' ? StickyNote : r.type === 'team_chat' ? MessageSquare : Send
                        const key = r.type === 'portal_chat' ? `portal_chat-${r.contactId}-${r.accountId ?? ''}` : `${r.type}-${r.id}`
                        return (
                          <button
                            key={key}
                            onClick={() => void handleQuickSend(r)}
                            disabled={quickSending}
                            className="flex items-center gap-2 truncate rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 disabled:opacity-40"
                          >
                            <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="truncate">{r.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setDestinationChoice('sticky_note')}
                    className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
                  >
                    <StickyNote className="h-4 w-4 text-zinc-500" />
                    {recents.length > 0 ? 'A different sticky note' : 'A sticky note'}
                  </button>
                  <button
                    onClick={() => setDestinationChoice('team_chat')}
                    className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
                  >
                    <MessageSquare className="h-4 w-4 text-zinc-500" />
                    {recents.length > 0 ? 'A different team chat conversation' : 'A team chat conversation'}
                  </button>
                  <button
                    onClick={() => setDestinationChoice('portal_chat')}
                    className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
                  >
                    <Send className="h-4 w-4 text-zinc-500" />
                    A client portal chat
                  </button>
                </div>
              </div>
            )}

            {stage === 'destination' && uploadedCaptureId && destinationChoice === 'sticky_note' && (
              <NoteDestinationPicker captureId={uploadedCaptureId} onAttached={() => handleAttached()} onError={handleDestinationError} />
            )}

            {stage === 'destination' && uploadedCaptureId && destinationChoice === 'team_chat' && (
              <TeamChatDestinationPicker captureId={uploadedCaptureId} onSent={() => handleAttached()} onError={handleDestinationError} />
            )}

            {stage === 'destination' && uploadedCaptureId && destinationChoice === 'portal_chat' && (
              <PortalChatDestinationPicker
                captureId={uploadedCaptureId}
                imageFile={capturedFile}
                prefilled={portalChatPrefill}
                onSent={(label) => handleAttached(label)}
                onError={handleDestinationError}
              />
            )}

            {stage === 'done' && (
              <div className="py-8 text-center text-sm text-emerald-600">{doneMessage ?? 'Saved.'}</div>
            )}

            {stage === 'error' && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-red-600">{errorMessage}</p>
                <button
                  onClick={() => {
                    setDestinationChoice(null)
                    setStage(uploadedCaptureId ? 'destination' : 'mode')
                  }}
                  className="rounded-md border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Full-viewport tap-catcher for the two-corner selection. Deliberately not a
 * drag: a continuous drag gesture fights normal page scrolling on the phone —
 * the same gesture-conflict class lib/ui/draggable-fab.ts already had to
 * build a tap-vs-drag threshold for. A light tint plus a live rectangle
 * between the two taps stands in for a real live preview (UX review,
 * 2026-09-04: "closer to required than optional").
 */
function SelectionOverlay({
  firstPoint,
  livePoint,
  onPoint,
  onMove,
  onCancel,
}: {
  firstPoint: Point | null
  livePoint: Point | null
  onPoint: (p: Point) => void
  onMove: (p: Point) => void
  onCancel: () => void
}) {
  const overlayRef = useRef<HTMLDivElement>(null)

  const pointFromEvent = (e: React.MouseEvent | React.TouchEvent): Point => {
    if ('touches' in e && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }
    const me = e as React.MouseEvent
    return { x: me.clientX, y: me.clientY }
  }

  const rect: CaptureRect | null =
    firstPoint && livePoint
      ? rectFromTwoPoints(firstPoint, livePoint, {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        })
      : null

  return (
    <div
      ref={overlayRef}
      {...{ [CAPTURE_TOOL_IGNORE_ATTR]: true }}
      className="fixed inset-0 z-[55] cursor-crosshair touch-none bg-black/10"
      onClick={(e) => onPoint(pointFromEvent(e))}
      onTouchStart={(e) => {
        e.preventDefault()
        onPoint(pointFromEvent(e))
      }}
      onMouseMove={(e) => firstPoint && onMove(pointFromEvent(e))}
      onTouchMove={(e) => {
        if (!firstPoint) return
        e.preventDefault()
        onMove(pointFromEvent(e))
      }}
    >
      <div className="pointer-events-none fixed left-1/2 top-4 -translate-x-1/2 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-white">
        {firstPoint ? 'Tap the opposite corner' : 'Tap one corner of the area'}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onCancel()
        }}
        className="fixed right-4 top-4 rounded-full bg-zinc-900/80 p-2 text-white"
        aria-label="Cancel"
      >
        <X className="h-5 w-5" />
      </button>
      {rect && (
        <div
          className="pointer-events-none fixed border-2 border-amber-400 bg-amber-400/10"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
    </div>
  )
}
