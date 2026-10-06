'use client'

import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minus, RotateCw, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { absoluteNavUrl } from '@/lib/nav/nav-link'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  EMPTY_STATE, WINDOWS_MIN_VIEWPORT_WIDTH, WINDOW_TITLEBAR_H,
  clampAll, clampBox, closeWindow, focusWindow, frontWindowId, isOpenFailure, isSignedOutPath, isWindowableUrl, sameWindowPage,
  minimizeWindow, openWindow, resizeBox, restoreWindow, setBox, setLocation,
  type ResizeEdge, type Viewport, type WindowBox, type WindowEntry, type WindowsState,
} from '@/lib/windows/window-model'
import { WIN_MSG, parseFrameMessage, type ParentMessage } from '@/lib/windows/window-messages'
import { browserStore, clearAllWindows, loadWindows, pruneOtherUsers, saveWindows } from '@/lib/windows/windows-storage'
import {
  OPEN_WINDOW_EVENT, WindowsAvailableContext, type OpenWindowDetail,
} from '@/lib/windows/windows-context'
import { CAPTURE_TOOL_IGNORE_ATTR } from '@/lib/captures/render'

/**
 * Floating windows (dev job f3f3e237, step 5): up to three real CRM pages shown in frames on top of
 * whatever page you are on — movable, resizable, minimisable — that stay put while the page behind
 * them changes. Mounted ONCE in the dashboard layout, outside <main> (like the floating chat), so a
 * page change never touches them. Never mounted inside a window itself, never below 1024px wide.
 *
 * The rules live in lib/windows/window-model.ts (pure, tested); the frame's side of the
 * conversation is lib/embed/window-bridge.ts. This file only draws and wires.
 */

export function WindowsAvailableProvider({ available, children }: { available: boolean; children: React.ReactNode }) {
  return <WindowsAvailableContext.Provider value={available}>{children}</WindowsAvailableContext.Provider>
}

/** The name every pop-out browser window gets, so it can tell it is one. */
const POPOUT_NAME = 'td-popout'

type Status = 'ok' | 'signedout' | 'gone'
type ConfirmAction = 'close' | 'popout' | 'dock' | 'reload'

interface Trail {
  stack: string[]
  idx: number
  /** Set while the window's own back / forward is in flight, so the frame's report is not mistaken for a new page. */
  pending: boolean
  /** Where the trail pointed before the in-flight back / forward (restored if the frame never answers). */
  prevIdx: number
  reports: number
}

const CURSORS: Record<ResizeEdge, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

const EDGE_CLASS: Record<ResizeEdge, string> = {
  n: 'left-3 right-3 top-0 h-2',
  s: 'left-3 right-3 bottom-0 h-2',
  w: 'top-3 bottom-3 left-0 w-2',
  e: 'top-3 bottom-3 right-0 w-2',
  nw: 'left-0 top-0 h-3 w-3',
  ne: 'right-0 top-0 h-3 w-3',
  sw: 'left-0 bottom-0 h-3 w-3',
  se: 'right-0 bottom-0 h-3 w-3',
}

function readViewport(topInset: number): Viewport {
  return { vw: window.innerWidth, vh: window.innerHeight, topInset }
}

/**
 * The public component. Two guards that must hold whatever the server decided:
 *  - never inside a frame (a window that lost its "I am a window" label would otherwise build its own
 *    windows, which build theirs…), and never in a pop-out browser window (which would load the same
 *    remembered windows a second time);
 *  - once on, it STAYS on for the life of the page: a failed settings read on a later refresh must not
 *    tear down every window and the typing in them. Turning the admin switch off takes effect on the next
 *    full load.
 */
export function WindowManager({ userId, sandbox, enabled }: { userId: string; sandbox: boolean; enabled: boolean }) {
  const [on] = useState(enabled)
  const [allowed, setAllowed] = useState(false)
  useEffect(() => {
    let framed = false
    try {
      framed = window.self !== window.top
    } catch {
      framed = true
    }
    setAllowed(!framed && !window.name.startsWith(POPOUT_NAME))
  }, [])
  if (!on || !allowed) return null
  return (
    <WindowsCrashGuard>
      <WindowManagerInner userId={userId} sandbox={sandbox} />
    </WindowsCrashGuard>
  )
}

/** A crash inside the windows must never white-screen the CRM around them (the page-level boundary does not catch layout throws). */
class WindowsCrashGuard extends Component<{ children: React.ReactNode }, { crashed: boolean }> {
  state = { crashed: false }
  static getDerivedStateFromError() {
    return { crashed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('[windows] crashed', error)
  }
  render() {
    return this.state.crashed ? null : this.props.children
  }
}

function WindowManagerInner({ userId, sandbox }: { userId: string; sandbox: boolean }) {
  const router = useRouter()
  const topInset = sandbox ? 40 : 0

  const [state, setState] = useState<WindowsState>(EMPTY_STATE)
  const [vp, setVp] = useState<Viewport | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [navTick, setNavTick] = useState(0)
  const [confirm, setConfirm] = useState<{ id: string; action: ConfirmAction } | null>(null)
  const [dragCursor, setDragCursor] = useState<string | null>(null)

  const stateRef = useRef(state)
  const statusRef = useRef<Record<string, Status>>({})
  const vpRef = useRef<Viewport | null>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const trails = useRef(new Map<string, Trail>())
  const initialSrc = useRef(new Map<string, string>())
  const everShown = useRef(new Set<string>())
  const asking = useRef(new Map<string, (dirty: boolean) => void>())
  const goBackRef = useRef<(id: string) => void>(() => {})
  const askSeq = useRef(0)

  statusRef.current = status

  const commit = useCallback((next: WindowsState) => {
    stateRef.current = next
    setState(next)
  }, [])

  // ── start up: size of the screen, this person's remembered windows ──
  useEffect(() => {
    const v = readViewport(topInset)
    vpRef.current = v
    setVp(v)
    const store = browserStore()
    pruneOtherUsers(store, userId)
    // Load against at least a desktop-size screen: on a narrow screen nothing is drawn, and clamping to
    // it would permanently shrink what was remembered. The real screen re-clamps once it is wide.
    commit(loadWindows(store, userId, { ...v, vw: Math.max(v.vw, WINDOWS_MIN_VIEWPORT_WIDTH), vh: Math.max(v.vh, 600) }))
    setHydrated(true)
  }, [userId, topInset, commit])

  useEffect(() => {
    const onResize = () => {
      const v = readViewport(topInset)
      vpRef.current = v
      setVp(v)
      if (v.vw >= WINDOWS_MIN_VIEWPORT_WIDTH) commit(clampAll(stateRef.current, v))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [topInset, commit])

  // A window that was hidden by a narrow screen has its page unmounted; when the screen is wide again it must
  // come back at the page it was ON, not the one it first opened with — so forget the seeds (they are
  // re-created from the remembered address on the next draw).
  useEffect(() => {
    if (vp && vp.vw < WINDOWS_MIN_VIEWPORT_WIDTH) {
      initialSrc.current.clear()
      everShown.current.clear()
      trails.current.clear()
    }
  }, [vp])

  // ── remember (debounced) ──
  useEffect(() => {
    if (!hydrated) return
    if (vpRef.current && vpRef.current.vw < WINDOWS_MIN_VIEWPORT_WIDTH) return // nothing changes while hidden
    const t = setTimeout(() => saveWindows(browserStore(), userId, state), 250)
    return () => clearTimeout(t)
  }, [state, hydrated, userId])

  // ── signed out, any way it happens: forget everything ──
  useEffect(() => {
    const { data } = createClient().auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') {
        clearAllWindows(browserStore())
        commit(EMPTY_STATE)
        frames.current.clear()
        trails.current.clear()
        initialSrc.current.clear()
        everShown.current.clear()
        setStatus({})
        setConfirm(null)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [commit])

  // ── anything in the CRM can ask for a window ──
  useEffect(() => {
    const onOpen = (e: Event) => {
      const v = vpRef.current ?? readViewport(topInset)
      if (v.vw < WINDOWS_MIN_VIEWPORT_WIDTH) {
        toast.error('Floating windows are only available on a computer-size screen.')
        return
      }
      const d = (e as CustomEvent<OpenWindowDetail>).detail
      // A dead window (signed out / page gone) would otherwise swallow the same address as a "duplicate".
      let base = stateRef.current
      const dead = typeof d?.href === 'string'
        ? base.windows.find(w => sameWindowPage(w.url, d.href) && (statusRef.current[w.id] ?? 'ok') !== 'ok')
        : undefined
      if (dead) {
        base = closeWindow(base, dead.id)
        frames.current.delete(dead.id)
        trails.current.delete(dead.id)
        initialSrc.current.delete(dead.id)
        everShown.current.delete(dead.id)
        setStatus(s => {
          const rest = { ...s }
          delete rest[dead.id]
          return rest
        })
      }
      const r = openWindow(base, d?.href, d?.title, v)
      if (isOpenFailure(r)) {
        toast.error(
          r.reason === 'cap'
            ? 'You already have 3 windows open. Close one first.'
            : "This page can't be opened in a window.",
        )
        return
      }
      commit(r.state)
    }
    document.addEventListener(OPEN_WINDOW_EVENT, onOpen)
    return () => document.removeEventListener(OPEN_WINDOW_EVENT, onOpen)
  }, [commit, topInset])

  // ── what the pages inside the windows tell us ──
  useEffect(() => {
    const idOf = (source: MessageEventSource | null): string | null => {
      let found: string | null = null
      frames.current.forEach((f, id) => {
        if (f.contentWindow && f.contentWindow === source) found = id
      })
      return found
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const msg = parseFrameMessage(e.data)
      if (!msg) return
      const id = idOf(e.source)
      if (!id) return
      if (msg.k === 'focus') {
        commit(focusWindow(stateRef.current, id))
      } else if (msg.k === 'back') {
        goBackRef.current(id)
      } else if (msg.k === 'key') {
        document.dispatchEvent(new CustomEvent('open-command-palette'))
      } else if (msg.k === 'dirty-answer') {
        const done = asking.current.get(msg.req)
        if (done) {
          asking.current.delete(msg.req)
          done(msg.dirty)
        }
      } else if (msg.k === 'loc') {
        const path = msg.url.split(/[?#]/)[0]
        if (isSignedOutPath(path)) {
          setStatus(s => ({ ...s, [id]: 'signedout' }))
          return
        }
        if (!isWindowableUrl(msg.url)) {
          setStatus(s => ({ ...s, [id]: 'gone' }))
          return
        }
        const gone = msg.title.startsWith('404')
        setStatus(s => {
          const cur = s[id] ?? 'ok'
          if (cur === 'signedout') return s
          const next: Status = gone ? 'gone' : 'ok'
          return cur === next ? s : { ...s, [id]: next }
        })
        const t = trails.current.get(id)
        if (t) {
          t.reports += 1
          if (t.pending) {
            // Our own Back / Forward is in flight: only the report of the page we asked for settles it.
            if (msg.url === t.stack[t.idx]) t.pending = false
            else if (!msg.replace && msg.url !== t.stack[t.prevIdx]) {
              t.stack[t.idx] = msg.url // the target redirected somewhere else
              t.pending = false
            }
          } else if (t.reports === 1 || msg.replace) {
            t.stack[t.idx] = msg.url // the first report may follow a redirect; a replace is not a new page
          } else if (t.stack[t.idx] !== msg.url) {
            t.stack = t.stack.slice(0, t.idx + 1)
            t.stack.push(msg.url)
            t.idx += 1
          }
          setNavTick(n => n + 1)
        }
        commit(setLocation(stateRef.current, id, msg.url, msg.title))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [commit])

  // ── actions ──
  const askDirty = useCallback((id: string) => {
    return new Promise<boolean>(resolve => {
      const f = frames.current.get(id)
      if (!f?.contentWindow) return resolve(false)
      const req = `${id}-${++askSeq.current}`
      asking.current.set(req, resolve)
      const msg: ParentMessage = { t: WIN_MSG, k: 'ask-dirty', req }
      f.contentWindow.postMessage(msg, window.location.origin)
      setTimeout(() => {
        if (asking.current.delete(req)) resolve(false) // a frame that does not answer has nothing to lose
      }, 500)
    })
  }, [])

  const perform = useCallback((id: string, action: ConfirmAction) => {
    const w = stateRef.current.windows.find(x => x.id === id)
    if (!w) return
    if (action === 'reload') {
      try {
        frames.current.get(id)?.contentWindow?.location.reload()
      } catch { /* frame is gone — nothing to reload */ }
      return
    }
    if (action === 'popout') {
      const url = absoluteNavUrl(window.location.origin, w.url)
      // Named, so the new browser window knows it is a pop-out and does not load these windows again.
      const popup = window.open(url, `${POPOUT_NAME}-${id}-${Date.now()}`, `popup=yes,width=${Math.round(w.w)},height=${Math.round(w.h)}`)
      if (!popup) {
        // Blocked by the browser: keep the window — closing it would lose the page.
        toast.error('Your browser blocked the separate window. Allow pop-ups for this site and try again.')
        return
      }
    } else if (action === 'dock') {
      router.push(w.url)
    }
    commit(closeWindow(stateRef.current, id))
    frames.current.delete(id)
    trails.current.delete(id)
    initialSrc.current.delete(id)
    everShown.current.delete(id)
    setStatus(s => {
      const rest = { ...s }
      delete rest[id]
      return rest
    })
  }, [commit, router])

  const guarded = useCallback(async (id: string, action: ConfirmAction) => {
    if (await askDirty(id)) {
      // The question is drawn inside the window: a minimised (hidden) window must be shown first.
      commit(focusWindow(restoreWindow(stateRef.current, id), id))
      setConfirm({ id, action })
    } else perform(id, action)
  }, [askDirty, perform, commit])

  const goBackForward = useCallback((id: string, delta: -1 | 1) => {
    const t = trails.current.get(id)
    const f = frames.current.get(id)
    if (!t || !f?.contentWindow) return
    const next = t.idx + delta
    if (next < 0 || next >= t.stack.length) return
    t.prevIdx = t.idx
    t.idx = next
    t.pending = true
    setNavTick(n => n + 1)
    const msg: ParentMessage = { t: WIN_MSG, k: 'go', url: t.stack[next] }
    f.contentWindow.postMessage(msg, window.location.origin)
    // The frame may not be listening yet (still loading). If it never answers, put the trail back.
    setTimeout(() => {
      if (t.pending && t.idx === next) {
        t.pending = false
        t.idx = t.prevIdx
        setNavTick(n => n + 1)
      }
    }, 3000)
  }, [])

  useEffect(() => {
    goBackRef.current = id => goBackForward(id, -1)
  }, [goBackForward])

  // ── drag and resize ──
  const beginDrag = useCallback((e: React.PointerEvent, w: WindowEntry, mode: 'move' | ResizeEdge) => {
    if (e.button !== 0) return
    const v = vpRef.current
    if (!v) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    commit(focusWindow(stateRef.current, w.id))
    const start: WindowBox = { x: w.x, y: w.y, w: w.w, h: w.h }
    const sx = e.clientX
    const sy = e.clientY
    setDragCursor(mode === 'move' ? 'grabbing' : CURSORS[mode])
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      const box = mode === 'move'
        ? clampBox({ ...start, x: start.x + dx, y: start.y + dy }, v)
        : resizeBox(start, mode, dx, dy, v)
      commit(setBox(stateRef.current, w.id, box))
    }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      el.removeEventListener('lostpointercapture', end)
      setDragCursor(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    // If the element is re-created or the capture is taken away, the click-blocking sheet must still go.
    el.addEventListener('lostpointercapture', end)
  }, [commit])

  if (!hydrated || !vp || vp.vw < WINDOWS_MIN_VIEWPORT_WIDTH) return null

  // Draw in a STABLE order (creation order) and stack with z-index only. Re-ordering the elements would make
  // the browser reload a window's page whenever it is brought to the front, and break an in-progress drag.
  const rankOf = new Map([...state.windows].sort((a, b) => a.z - b.z).map((w, i) => [w.id, i]))
  const front = frontWindowId(state)
  const minimized = state.windows.filter(w => w.minimized)
  void navTick // re-render when a trail changes (back / forward buttons)

  return (
    <div
      {...{ [CAPTURE_TOOL_IGNORE_ATTR]: '' }}
      data-floating-windows=""
      className="pointer-events-none fixed inset-0 z-[44] hidden lg:block"
      style={{ isolation: 'isolate' }}
    >
      {state.windows.map(w => {
        const rank = rankOf.get(w.id) ?? 0
        const st = status[w.id] ?? 'ok'
        const t = trails.current.get(w.id)
        if (!initialSrc.current.has(w.id)) initialSrc.current.set(w.id, w.url)
        if (!trails.current.has(w.id)) trails.current.set(w.id, { stack: [w.url], idx: 0, pending: false, prevIdx: 0, reports: 0 })
        if (!w.minimized) everShown.current.add(w.id)
        const mountFrame = st === 'ok' && everShown.current.has(w.id)
        const isFront = front === w.id
        return (
          <div
            key={w.id}
            role="group"
            aria-label={`Window: ${w.title}`}
            className={cn(
              'pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border bg-white',
              isFront ? 'border-zinc-400 shadow-2xl' : 'border-zinc-300 shadow-lg',
              w.minimized && 'hidden',
            )}
            style={{ left: w.x, top: w.y, width: w.w, height: w.h, zIndex: 10 + rank }}
            onPointerDownCapture={() => {
              if (!isFront) commit(focusWindow(stateRef.current, w.id))
            }}
          >
            <div
              className={cn(
                'flex shrink-0 cursor-grab select-none items-center gap-0.5 border-b px-1.5 active:cursor-grabbing',
                isFront ? 'bg-zinc-800 text-white' : 'bg-zinc-600 text-zinc-100',
              )}
              style={{ height: WINDOW_TITLEBAR_H }}
              onPointerDown={e => {
                if ((e.target as HTMLElement).closest('button')) return
                beginDrag(e, w, 'move')
              }}
              onDoubleClick={e => {
                if ((e.target as HTMLElement).closest('button')) return
                commit(minimizeWindow(stateRef.current, w.id))
              }}
            >
              <TitleButton label="Back" disabled={!t || t.idx <= 0} onClick={() => goBackForward(w.id, -1)}><ChevronLeft className="h-4 w-4" /></TitleButton>
              <TitleButton label="Forward" disabled={!t || t.idx >= t.stack.length - 1} onClick={() => goBackForward(w.id, 1)}><ChevronRight className="h-4 w-4" /></TitleButton>
              <TitleButton label="Reload this window" onClick={() => void guarded(w.id, 'reload')}><RotateCw className="h-3.5 w-3.5" /></TitleButton>
              <div className="mx-2 min-w-0 flex-1 truncate text-sm font-medium" title={w.url}>{w.title}</div>
              <TitleButton label="Minimise" onClick={() => commit(minimizeWindow(stateRef.current, w.id))}><Minus className="h-4 w-4" /></TitleButton>
              <TitleButton label="Open in a separate browser window" onClick={() => void guarded(w.id, 'popout')}><ExternalLink className="h-3.5 w-3.5" /></TitleButton>
              <TitleButton label="Open in the main page and close this window" onClick={() => void guarded(w.id, 'dock')}><Maximize2 className="h-3.5 w-3.5" /></TitleButton>
              <TitleButton label="Close" onClick={() => void guarded(w.id, 'close')}><X className="h-4 w-4" /></TitleButton>
            </div>

            <div className="relative min-h-0 flex-1 bg-zinc-50">
              {mountFrame && (
                <iframe
                  ref={el => {
                    if (el) frames.current.set(w.id, el)
                    else frames.current.delete(w.id)
                  }}
                  src={initialSrc.current.get(w.id)}
                  title={`Window: ${w.title}`}
                  className="h-full w-full border-0"
                />
              )}
              {st !== 'ok' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center">
                  <p className="max-w-sm text-sm text-zinc-700">
                    {st === 'signedout'
                      ? 'You were signed out. Sign in again on the main page, then open this window again.'
                      : "This page isn't available any more."}
                  </p>
                  <button
                    type="button"
                    onClick={() => perform(w.id, 'close')}
                    className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700"
                  >
                    Close window
                  </button>
                </div>
              )}
              {confirm?.id === w.id && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 p-6 text-center">
                  <p className="max-w-sm text-sm text-zinc-800">
                    There is typing in this window that has not been sent or saved. If you continue, it will be lost.
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50">
                      Keep the window
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const c = confirm
                        setConfirm(null)
                        perform(c.id, c.action)
                      }}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
                    >
                      Continue anyway
                    </button>
                  </div>
                </div>
              )}
            </div>

            {(Object.keys(EDGE_CLASS) as ResizeEdge[]).map(edge => (
              <div
                key={edge}
                aria-hidden
                className={cn('absolute z-20', EDGE_CLASS[edge])}
                style={{ cursor: CURSORS[edge], touchAction: 'none' }}
                onPointerDown={e => beginDrag(e, w, edge)}
              />
            ))}
          </div>
        )
      })}

      {/* Frames swallow the mouse, so while dragging or resizing a transparent sheet covers them. */}
      {dragCursor && <div className="pointer-events-auto absolute inset-0" style={{ zIndex: 1000, cursor: dragCursor }} />}

      {minimized.length > 0 && (
        <div className="pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2" style={{ zIndex: 1001 }}>
          {minimized.map(w => (
            <div key={w.id} className="flex max-w-[16rem] items-center overflow-hidden rounded-full border border-zinc-400 bg-zinc-800 text-sm text-white shadow-lg">
              <button
                type="button"
                aria-label={`Show window: ${w.title}`}
                className="truncate px-3 py-1.5 hover:bg-zinc-700"
                onClick={() => commit(focusWindow(restoreWindow(stateRef.current, w.id), w.id))}
              >
                {w.title}
              </button>
              <button
                type="button"
                aria-label={`Close ${w.title}`}
                className="px-2 py-1.5 hover:bg-zinc-700"
                onClick={() => void guarded(w.id, 'close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TitleButton({
  label, onClick, disabled, children,
}: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <FastTooltip label={label} align="center">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-200 hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        {children}
      </button>
    </FastTooltip>
  )
}
