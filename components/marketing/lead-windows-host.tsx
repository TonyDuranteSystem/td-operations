'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import type { BoardRole } from '@/lib/marketing/board'
import {
  DOCK_H, EMPTY_WINDOWS, FRAME_CHANGED, OPEN_TAB_MESSAGE, TITLEBAR_H, WINDOW_H, WINDOW_W, closeWindow, focusWindow, frontWindowId, minimizeWindow, moveWindow, openWindow, windowSrc,
  type Viewport, type WindowTab, type WindowsState,
} from '@/lib/marketing/lead-windows'

const ROLE_KEY = 'tdm_board_role'
/** the screens read the leads again this often while on screen, so a new chat message shows (the red numbers) without a click */
const REFRESH_MS = 15_000

interface Api {
  /** Open a lead in a floating window (max 3). `tab` = 'chat' opens its Chat tab. */
  open: (lead: { id: string; name: string }, tab?: WindowTab) => void
  /** the board the person works from (an owner may use both) */
  role: BoardRole
  roles: BoardRole[]
  setRole: (r: BoardRole) => void
}
const Ctx = createContext<Api | null>(null)

/** Where a lead goes when no window host is around (never on the workspace screens): its own page. */
export const leadHref = (id: string) => `/marketing/board?open=${id}`

export function useLeadWindows(): Api {
  const c = useContext(Ctx)
  if (c) return c
  return { open: lead => { window.location.href = leadHref(lead.id) }, role: 'setter', roles: ['setter'], setRole: () => undefined }
}

/**
 * TD Marketing — the floating lead windows for EVERY screen of the workspace (dev job 9aec66fa): a lead opens in a window on top of whatever page you are on (max 3; drag,
 * minimize to the bar at the bottom, close), and the page behind stays where it was. Mounted once in the workspace frame. A window shows the lead's own page in a frame
 * (/marketing/window/[id]), so it has exactly the buttons and the privacy of that page. The pure rules are in lib/marketing/lead-windows.ts.
 */
export function LeadWindowsHost({ defaultRole, roles, chatOn, children }: { defaultRole: BoardRole; roles: BoardRole[]; chatOn: boolean; children: React.ReactNode }) {
  const t = useT()
  const router = useRouter()
  const params = useSearchParams()
  const [role, setRoleState] = useState<BoardRole>(defaultRole)
  const [wins, setWins] = useState<WindowsState>(EMPTY_WINDOWS)
  const [dragging, setDragging] = useState(false)
  const vpRef = useRef<Viewport>({ w: 1280, h: 800 })
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  // the board this person last chose (only when he may use both)
  const rolesKey = roles.join(',')
  useEffect(() => {
    try { const saved = window.localStorage.getItem(ROLE_KEY); if (saved && rolesKey.split(',').includes(saved)) setRoleState(saved as BoardRole) } catch { /* only a convenience */ }
  }, [rolesKey])
  const setRole = useCallback((r: BoardRole) => {
    setRoleState(r)
    try { window.localStorage.setItem(ROLE_KEY, r) } catch { /* only a convenience */ }
  }, [])

  const open = useCallback((c: { id: string; name: string }, tab?: WindowTab) => {
    setWins(s => openWindow(s, { id: c.id, name: c.name || '…', tab }, vpRef.current))
    // a lead that is already open stays as it is (nothing typed is lost); the page inside is told to switch tab
    if (tab) setTimeout(() => {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-lead="${CSS.escape(c.id)}"]`)
      frame?.contentWindow?.postMessage({ type: OPEN_TAB_MESSAGE, tab }, window.location.origin)
    }, 50)
  }, [])

  // an address like …?open=<lead> or …?chat=<lead> (a tapped notification, a link) opens that lead once; the address is then cleaned so a refresh does not reopen it
  const handled = useRef(new Set<string>())
  useEffect(() => {
    const id = params.get('open') ?? params.get('lead') ?? params.get('chat')
    const tab: WindowTab | undefined = params.get('chat') && chatOn ? 'chat' : undefined
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || handled.current.has(id + (tab ?? ''))) return
    handled.current.add(id + (tab ?? ''))
    open({ id, name: t('Lead') }, tab)
    try {
      const u = new URL(window.location.href)
      for (const k of ['open', 'lead', 'chat']) u.searchParams.delete(k)
      window.history.replaceState(null, '', u.pathname + (u.search || ''))
    } catch { /* the address is only cosmetic */ }
  }, [params, chatOn, open, t])

  useEffect(() => {
    const measure = () => { vpRef.current = { w: window.innerWidth, h: window.innerHeight } }
    measure()
    window.addEventListener('resize', measure)
    // a save inside a lead window: read the leads again so the screen behind shows it (waits a moment so several saves in a row make one read)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || (e.data as { type?: string } | null)?.type !== FRAME_CHANGED) return
      clearTimeout(timer)
      timer = setTimeout(() => router.refresh(), 400)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('message', onMessage); clearTimeout(timer) }
  }, [router])

  useEffect(() => {
    if (!chatOn) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') router.refresh() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [chatOn, router])

  const onDown = (e: React.PointerEvent, id: string, x: number, y: number) => {
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { id, dx: e.clientX - x, dy: e.clientY - y }
    setDragging(true)
    setWins(s => focusWindow(s, id))
  }
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => { const d = drag.current; if (d) setWins(s => moveWindow(s, d.id, e.clientX - d.dx, e.clientY - d.dy, vpRef.current)) }
    const up = () => { drag.current = null; setDragging(false) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [dragging])

  const api = useMemo<Api>(() => ({ open, role, roles, setRole }), [open, role, roles, setRole])
  const front = frontWindowId(wins)
  return (
    <Ctx.Provider value={api}>
      {children}
      {wins.list.map(w => {
        // a minimized window is only hidden, not removed: what was typed in it, and an upload in flight, are still there when it comes back
        const src = windowSrc(w.id, w.srcTab, role)
        return (
          <div key={w.id} role="dialog" aria-label={w.name} data-testid="lead-window" data-lead={w.id}
            className={`fixed flex flex-col overflow-hidden rounded-xl border bg-white shadow-2xl ${front === w.id ? 'border-slate-500' : 'border-slate-300'}`}
            style={{ display: w.minimized ? 'none' : undefined, left: w.x, top: w.y, zIndex: 40 + w.z, width: WINDOW_W, height: Math.min(WINDOW_H, Math.max(320, vpRef.current.h - w.y - DOCK_H - 8)) }}
            onPointerDownCapture={() => { if (front !== w.id) setWins(s => focusWindow(s, w.id)) }}>
            <div className="flex shrink-0 cursor-move select-none items-center justify-between gap-2 border-b bg-slate-100 px-3 text-sm font-medium" style={{ height: TITLEBAR_H, touchAction: 'none' }}
              onPointerDown={e => onDown(e, w.id, w.x, w.y)}>
              <span className="min-w-0 truncate">{w.name}</span>
              <span className="flex shrink-0 gap-1">
                <button type="button" aria-label={t('Minimize')} data-testid="win-min" onClick={() => setWins(s => minimizeWindow(s, w.id))} className="rounded px-2 py-0.5 text-lg leading-none hover:bg-slate-200">−</button>
                <button type="button" aria-label={t('Close')} data-testid="win-close" onClick={() => setWins(s => closeWindow(s, w.id))} className="rounded px-2 py-0.5 text-lg leading-none hover:bg-slate-200">×</button>
              </span>
            </div>
            {src ? <iframe key={w.id} data-lead={w.id} title={w.name} src={src} className="min-h-0 w-full flex-1 border-0 bg-slate-50" style={dragging ? { pointerEvents: 'none' } : undefined} /> : null}
          </div>
        )
      })}

      {wins.list.length > 0 && (
        <div className="fixed bottom-0 left-60 right-0 z-[200] flex items-center gap-2 border-t bg-white/95 px-4 text-xs shadow-[0_-2px_8px_rgba(0,0,0,.06)]" style={{ height: DOCK_H }} data-testid="window-dock">
          <span className="text-slate-400">{t('Windows')}</span>
          {wins.list.map(w => (
            <span key={w.id} className={`flex items-center overflow-hidden rounded-full border ${w.minimized ? 'bg-white' : 'bg-slate-100'}`}>
              <button type="button" onClick={() => setWins(s => (w.minimized ? openWindow(s, { id: w.id, name: w.name }, vpRef.current) : focusWindow(s, w.id)))} className="max-w-[10rem] truncate px-3 py-1 hover:bg-slate-50" data-testid="dock-item">{w.name}</button>
              <button type="button" aria-label={t('Close')} onClick={() => setWins(s => closeWindow(s, w.id))} className="px-2 py-1 text-slate-400 hover:text-slate-900">×</button>
            </span>
          ))}
        </div>
      )}
    </Ctx.Provider>
  )
}
