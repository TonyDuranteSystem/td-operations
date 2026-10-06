'use client'

/**
 * The reply pop-up: a large window for writing a reply with the email you are answering beside it.
 *
 * Why (dev job bbc70ff8, Antonio 2026-10-06): the inline reply box is a fixed strip under the thread; he asked
 * for "a pop up page that I have more space to write and to work on". This component is ONLY the window —
 * it owns no reply state. ComposeReply keeps the text, recipients, attachments and AI state and passes the
 * writing column in as `children`, so opening or closing the pop-up can never lose or fork a draft.
 *
 * Behaviour:
 *  - Wide screens: the thread (read-only) on the left, the writing column on the right.
 *  - Phone: a full-screen sheet; a switch at the top flips between "Email" and "Write" (no room for two panes).
 *  - Esc and ✕ close it; the text stays in the inline box. Clicking the dim backdrop does NOT close it.
 *  - Rendered through a portal OUTSIDE the inline composer's DOM and React tree position (ComposeReply renders
 *    it as a sibling), so the inline box's blur/fold handlers never see events from in here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'

interface ReplyPopupProps {
  title: string
  subtitle?: string
  onClose: () => void
  /** The email you are answering (read-only thread view). */
  thread: React.ReactNode
  /** The writing column. */
  children: React.ReactNode
  /** Files dropped anywhere on the window are attached to the reply. */
  onFiles: (files: File[]) => void
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Same breakpoint as the layout's `md:` classes: wide enough for two panes. */
const TWO_PANES = '(min-width: 768px)'

export function ReplyPopup({ title, subtitle, onClose, thread, children, onFiles }: ReplyPopupProps) {
  const [view, setView] = useState<'write' | 'email'>('write')
  const panelRef = useRef<HTMLDivElement>(null)
  const threadPaneRef = useRef<HTMLDivElement>(null)
  // On a phone the email pane is hidden until its tab is chosen. The email view measures its own height once, when it
  // loads — inside a hidden pane that measurement is 0 and the message shows as a thin strip. So on a phone the
  // thread is only MOUNTED while its tab is showing (it then measures correctly); on a wide screen it always is.
  const [twoPanes, setTwoPanes] = useState(() => typeof window !== 'undefined' && window.matchMedia(TWO_PANES).matches)
  useEffect(() => {
    const mq = window.matchMedia(TWO_PANES)
    const onChange = () => setTwoPanes(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // The page behind must not scroll while the window is open.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  // Esc closes; Tab stays inside the window (a modal that lets focus escape to the page behind is a trap of its own).
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const panel = panelRef.current
      if (!panel) return
      const target = e.target as Node | null
      // Only act on keys that belong to THIS window: from inside it, or with nothing focused. A key pressed in
      // something layered above it (the Cmd+K search, a note editor) belongs to that thing, not to us.
      const mine =
        !target || target === document || target === document.body || target === document.documentElement || panel.contains(target)
      if (e.key === 'Escape') {
        if (e.defaultPrevented || e.isComposing || !mine) return
        // An overlay opened from the email pane (the Note editor is a full-screen layer) must close FIRST —
        // closing us instead would throw away the note being written.
        if (threadPaneRef.current?.querySelector('.fixed')) return
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !mine) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose]
  )
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  if (typeof document === 'undefined') return null

  return createPortal(
    // z-[58]: above the dashboard and floating windows, BELOW the Cmd+K search (z-60) and the note editor (z-80), so
    // those stay visible if opened from here. React events bubble through a portal along the React tree, so the
    // drag events are stopped at this root: a file dropped on the dim edge must not reach a drop handler of the
    // page this window was opened from (Portal Chats stages dropped files into the CLIENT chat).
    <div
      className="fixed inset-0 z-[58] flex items-stretch justify-center bg-black/55 md:p-6"
      onDragEnter={(e) => e.stopPropagation()}
      onDragOver={(e) => e.stopPropagation()}
      onDragLeave={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
    >
      <WorkerDropZone
        onFiles={onFiles}
        label="Drop files to attach to the reply"
        className="flex w-full max-w-[1120px] md:my-auto md:h-[min(88vh,860px)]"
      >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full flex-col overflow-hidden bg-white md:rounded-xl md:shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-900">{title}</p>
            {subtitle && <p className="truncate text-xs text-zinc-500">{subtitle}</p>}
          </div>
          <span className="hidden text-xs text-zinc-500 sm:inline">
            <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd> closes · your text is kept
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the pop-up — your text is kept"
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Phone only: one pane at a time. */}
        <div className="grid grid-cols-2 border-b border-zinc-200 md:hidden" role="tablist" aria-label="What to show">
          {(['email', 'write'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'py-2 text-sm font-medium transition-colors',
                view === v ? 'bg-blue-50 text-blue-700' : 'text-zinc-500 hover:bg-zinc-50'
              )}
            >
              {v === 'email' ? 'Email' : 'Write'}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 md:grid md:grid-cols-[5fr_7fr]">
          <div
            ref={threadPaneRef}
            className={cn(
              'min-h-0 min-w-0 flex-col border-zinc-200 bg-zinc-50 md:flex md:border-r',
              view === 'email' ? 'flex flex-1' : 'hidden'
            )}
          >
            <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              The email you are answering
            </p>
            <div className="flex min-h-0 flex-1 flex-col">{twoPanes || view === 'email' ? thread : null}</div>
          </div>
          <div className={cn('min-h-0 min-w-0 flex-col md:flex', view === 'write' ? 'flex flex-1' : 'hidden')}>
            {children}
          </div>
        </div>
      </div>
      </WorkerDropZone>
    </div>,
    document.body
  )
}
