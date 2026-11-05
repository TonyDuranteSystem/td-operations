'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  layoutsEqual,
  parseLayout,
  pickLayoutOnLoad,
  reconcileLayout,
  resolveLayout,
  standardLayout,
  type LocalCopy,
  type MenuLayout,
  type ServerLayoutStatus,
} from '@/lib/nav/menu-layout'

/**
 * The signed-in person's left-menu layout (dev job 45aa5872).
 *
 * Where it lives: on their LOGIN (the dashboard layout reads it on the server and hands it in as `initial`), so the same menu
 * follows them to every computer. A copy is also kept in this browser, flagged `synced: false` until the account has it, so a
 * failed save is never lost — after a reload the unsent edit wins and is sent again. Saving is debounced (a drag is many small
 * moves; only the last one is sent).
 *
 * Safety rules (bug-hunt 2026-11-04):
 * - If the account's layout could not be READ (`status: 'unavailable'`), nothing is ever sent and editing is off: the real saved
 *   layout may exist and a save would overwrite it with the standard one.
 * - A tab that was left open picks up the account's newer layout when you come back to it — unless you are editing, a save is
 *   waiting, or an edit has not reached the account yet.
 * - First time on the new menu — no account copy — the OLD per-browser order (the previous "Reorder sidebar") is carried over;
 *   "Reset" removes it too, so Reset really is the standard layout.
 */
const LEGACY_KEYS = ['td-sidebar-order-v3', 'td-sidebar-order']
const SAVE_DELAY_MS = 600
const REFRESH_EVERY_MS = 30_000

function readLocal(key: string): LocalCopy | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    // wrapper { synced, layout }; a plain layout (an earlier build) counts as already saved
    const layout = parseLayout(raw && typeof raw === 'object' && 'layout' in raw ? (raw as { layout: unknown }).layout : raw)
    if (!layout) return null
    const synced = raw && typeof raw === 'object' && 'synced' in raw ? (raw as { synced: unknown }).synced !== false : true
    return { layout, synced }
  } catch {
    return null
  }
}

function readLegacy(): string[] | null {
  try {
    for (const key of LEGACY_KEYS) {
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const legacy = JSON.parse(raw)
      if (Array.isArray(legacy)) return legacy.filter((x): x is string => typeof x === 'string')
    }
  } catch { /* storage unavailable or damaged */ }
  return null
}

export function useMenuLayout({ userId, initial, status, pageIds, busy }: {
  userId: string
  initial: unknown
  /** What the server's read of the account came back with. */
  status: ServerLayoutStatus
  pageIds: readonly string[]
  /** Editing or naming a group right now: do not swap the layout under the person's hands. */
  busy: boolean
}) {
  const localKey = `td-menu-layout-v1:${userId}`
  const canEdit = status !== 'unavailable'
  const [layout, setLayout] = useState<MenuLayout>(() => resolveLayout(initial, pageIds))
  const latest = useRef(layout)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef(false)
  const unsynced = useRef(false)
  const lastToast = useRef(0)
  const lastRefresh = useRef(0)
  const busyRef = useRef(busy)
  useEffect(() => { busyRef.current = busy }, [busy])
  useEffect(() => { latest.current = layout }, [layout])

  const writeLocal = useCallback((next: MenuLayout, synced: boolean) => {
    try { window.localStorage.setItem(localKey, JSON.stringify({ synced, layout: next })) } catch { /* ignore */ }
  }, [localKey])

  const complain = useCallback((message: string) => {
    // One message per 30 seconds: a drag session can fail several saves in a row.
    if (Date.now() - lastToast.current < 30_000) return
    lastToast.current = Date.now()
    toast.error(message)
  }, [])

  const send = useCallback(async () => {
    if (!canEdit || inflight.current) return
    inflight.current = true
    const sent = latest.current
    try {
      const res = await fetch('/api/dashboard/menu-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: sent }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d as { error?: string }).error || 'Could not save your menu. It is kept on this computer for now.')
      }
      // Only call it saved if nothing newer was edited while the request was out.
      if (layoutsEqual(sent, latest.current)) { unsynced.current = false; writeLocal(sent, true) }
    } catch (err) {
      complain(err instanceof Error && err.message ? err.message : 'Could not save your menu. It is kept on this computer for now.')
    } finally {
      inflight.current = false
    }
  }, [canEdit, complain, writeLocal])

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; void send() }, SAVE_DELAY_MS)
  }, [send])

  // After load the BROWSER decides (one rule, tested: pickLayoutOnLoad). The server's copy was only the first paint.
  useEffect(() => {
    const pick = pickLayoutOnLoad({ status, server: parseLayout(initial), local: readLocal(localKey), legacy: readLegacy(), pageIds })
    latest.current = pick.layout
    setLayout(pick.layout)
    if (pick.resend) { unsynced.current = true; scheduleSave() }
    else if (status === 'saved') writeLocal(pick.layout, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Use this layout now, keep a copy here (unsynced until the account has it), and save to the account in a moment. */
  const commit = useCallback((next: MenuLayout) => {
    if (!canEdit) return
    latest.current = next
    unsynced.current = true
    setLayout(next)
    writeLocal(next, false)
    scheduleSave()
  }, [canEdit, scheduleSave, writeLocal])

  /** Back to the standard groups: forget the saved layout everywhere. If the account cannot be reached, nothing changes. */
  const reset = useCallback(async () => {
    if (!canEdit) return
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const previous = latest.current
    const wasUnsynced = unsynced.current
    const std = standardLayout(pageIds)
    latest.current = std
    unsynced.current = false
    setLayout(std)
    try { window.localStorage.removeItem(localKey); for (const k of LEGACY_KEYS) window.localStorage.removeItem(k) } catch { /* ignore */ }
    try {
      const res = await fetch('/api/dashboard/menu-layout', { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d as { error?: string }).error || 'Could not reset your saved menu. Try again in a moment.')
      }
    } catch (err) {
      // The account still has the old layout, so show it again instead of pretending.
      latest.current = previous
      unsynced.current = wasUnsynced
      setLayout(previous)
      writeLocal(previous, !wasUnsynced)
      toast.error(err instanceof Error && err.message ? err.message : 'Could not reset your saved menu. Try again in a moment.')
    }
  }, [canEdit, localKey, pageIds, writeLocal])

  // Coming back to a tab: retry an unsent edit, or pick up the layout another computer saved meanwhile.
  useEffect(() => {
    if (!canEdit) return
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return
      if (unsynced.current) { if (!timer.current && !inflight.current) scheduleSave(); return }
      if (busyRef.current || timer.current || inflight.current) return
      if (Date.now() - lastRefresh.current < REFRESH_EVERY_MS) return
      lastRefresh.current = Date.now()
      try {
        const res = await fetch('/api/dashboard/menu-layout', { cache: 'no-store' })
        if (!res.ok) return
        const d = (await res.json()) as { status?: string; layout?: unknown }
        const server = d.status === 'saved' ? parseLayout(d.layout) : null
        if (!server || busyRef.current || timer.current || unsynced.current) return
        const next = reconcileLayout(server, pageIds)
        if (layoutsEqual(next, latest.current)) return
        latest.current = next
        setLayout(next)
        writeLocal(next, true)
      } catch { /* offline: try again next time */ }
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [canEdit, pageIds, scheduleSave, writeLocal])

  // Leaving the page with a save still waiting: send it now.
  useEffect(() => {
    const flush = () => {
      if (!timer.current || !canEdit) return
      clearTimeout(timer.current)
      timer.current = null
      try {
        // keepalive lets the request finish after the page is gone
        void fetch('/api/dashboard/menu-layout', {
          method: 'PUT',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layout: latest.current }),
        }).catch(() => {})
      } catch { /* the local copy (unsynced) still has it and is sent at the next load */ }
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [canEdit])

  return { layout, commit, reset, canEdit }
}
