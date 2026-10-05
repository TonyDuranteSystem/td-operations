/**
 * Floating windows — the rules, as pure functions (dev job f3f3e237, step 5).
 *
 * A "window" is a real CRM page shown in a frame on top of the page you are working on. Everything
 * that can be decided without a screen lives here so it is unit-tested (R086): which addresses may
 * open, how many windows, where a new one goes, how a drag/resize is clamped, and what is stored.
 * The component (components/windows/window-manager.tsx) only draws and wires events.
 */

import { isInternalNavHref } from '@/lib/nav/nav-link'

/** Antonio, 2026-10-05: at most three at once. */
export const MAX_WINDOWS = 3

/** Below this viewport width the CRM is in its phone layout — windows are desktop only. */
export const WINDOWS_MIN_VIEWPORT_WIDTH = 1024

/** A window narrower than ~1024px renders the page's phone layout inside it; still allowed. */
export const WINDOW_MIN_W = 480
export const WINDOW_MIN_H = 320
export const WINDOW_DEFAULT_W = 1040
export const WINDOW_DEFAULT_H = 680

/** Height of the window's title bar — a window is never allowed to hide its own title bar. */
export const WINDOW_TITLEBAR_H = 36

/** Keep at least this much of a window's title bar on screen horizontally. */
const KEEP_VISIBLE_X = 120

export interface WindowBox {
  x: number
  y: number
  w: number
  h: number
}

export interface WindowEntry extends WindowBox {
  id: string
  /** Same-site dashboard address, always re-validated (never trusted from storage). */
  url: string
  title: string
  minimized: boolean
  /** Stacking order among windows: higher is in front. */
  z: number
}

export interface WindowsState {
  windows: WindowEntry[]
  /** Highest z handed out so far (monotonic, so "bring to front" is just +1). */
  topZ: number
}

export interface Viewport {
  vw: number
  vh: number
  /** Space taken at the top (the sandbox banner); a window never goes above it. */
  topInset: number
}

export const EMPTY_STATE: WindowsState = { windows: [], topZ: 0 }

// ───────────────────────────── addresses ─────────────────────────────

/**
 * The CRM's own pages — an ALLOW-list of the first path segment, not a block-list. The dashboard
 * is a route group, so its pages live at /accounts, /tasks … mixed in with public and client-facing
 * routes (/lease, /offer, /pay, /portal …) that must never open in a window. A block-list would
 * silently let the next public route through; an allow-list fails the safe way. The list mirrors the
 * folders under app/(dashboard) — a unit test fails when a folder is added there and not here.
 * (Whether the CURRENT person may see a page is still decided by the server: an admin-only page
 * opened by someone else just redirects to the home page inside the window.)
 */
export const WINDOW_PAGE_ROOTS: readonly string[] = [
  'accounts', 'addresses', 'audit', 'calendar', 'captures', 'cases', 'catalog', 'client-health',
  'clients', 'code-tasks', 'config', 'contacts', 'conversations', 'dashboard', 'dev-board',
  'dev-tools', 'email-templates', 'exceptions', 'finance', 'flows', 'inbox', 'intake',
  'invoice-aging', 'invoice-settings', 'leads', 'notes', 'onboarding-review', 'owner', 'partners',
  'payments', 'pipeline', 'pipeline-overview', 'portal-chats', 'portal-launch', 'reconciliation',
  'referrals', 'research', 'sandbox-mail', 'service-catalog', 'services', 'shared', 'storage',
  'system-health', 'tasks', 'tax-returns', 'team-chat', 'team-management', 'tools', 'trackers',
  'workflow-issues', 'workflows',
]

function pathOf(href: string): string {
  const cut = href.search(/[?#]/)
  return cut === -1 ? href : href.slice(0, cut)
}

/** True for an address a window may show. Single leading slash only — never another site. */
export function isWindowableUrl(href: unknown): href is string {
  if (typeof href !== 'string') return false
  if (!isInternalNavHref(href)) return false
  const path = pathOf(href)
  if (path === '/') return true // the home page
  const root = path.slice(1).split('/')[0].toLowerCase()
  return WINDOW_PAGE_ROOTS.includes(root)
}

/** The pages that mean "you are signed out" — a frame landing here must tell the parent. */
export function isSignedOutPath(pathname: string): boolean {
  const p = pathname.toLowerCase()
  return p === '/login' || p.startsWith('/login/') || p === '/mfa' || p.startsWith('/mfa/')
}

/** Two addresses are "the same page" when path and query match (a #hash is ignored). */
export function sameWindowPage(a: string, b: string): boolean {
  const strip = (u: string) => {
    const i = u.indexOf('#')
    return i === -1 ? u : u.slice(0, i)
  }
  return strip(a) === strip(b)
}

/** A short title to show until the page reports its real one. */
export function fallbackTitle(url: string): string {
  const path = pathOf(url).replace(/^\/+/, '')
  if (!path) return 'Home'
  const first = path.split('/')[0].replace(/[-_]+/g, ' ')
  return first.charAt(0).toUpperCase() + first.slice(1)
}

// ───────────────────────────── geometry ─────────────────────────────

function finite(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/**
 * Keep a window usable: never smaller than the floor, never bigger than the screen, and the title
 * bar always reachable (it can be dragged most of the way off a side, never above the top edge).
 */
export function clampBox(box: WindowBox, vp: Viewport): WindowBox {
  const maxW = Math.max(WINDOW_MIN_W, vp.vw - 16)
  const maxH = Math.max(WINDOW_MIN_H, vp.vh - vp.topInset - 8)
  const w = Math.min(Math.max(finite(box.w, WINDOW_DEFAULT_W), WINDOW_MIN_W), maxW)
  const h = Math.min(Math.max(finite(box.h, WINDOW_DEFAULT_H), WINDOW_MIN_H), maxH)
  const minX = KEEP_VISIBLE_X - w
  const maxX = vp.vw - KEEP_VISIBLE_X
  const minY = vp.topInset
  const maxY = Math.max(minY, vp.vh - WINDOW_TITLEBAR_H)
  const x = Math.min(Math.max(finite(box.x, 0), minX), maxX)
  const y = Math.min(Math.max(finite(box.y, minY), minY), maxY)
  return { x, y, w, h }
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * The box after dragging an edge/corner by (dx, dy) from the box it had when the drag started.
 * The opposite edge stays put; the minimum size is respected without the window "sliding".
 */
export function resizeBox(start: WindowBox, edge: ResizeEdge, dx: number, dy: number, vp: Viewport): WindowBox {
  let { x, y, w, h } = start
  const right = start.x + start.w
  const bottom = start.y + start.h
  if (edge.includes('e')) w = start.w + dx
  if (edge.includes('s')) h = start.h + dy
  if (edge.includes('w')) {
    w = start.w - dx
    x = right - Math.max(w, WINDOW_MIN_W)
  }
  if (edge.includes('n')) {
    h = start.h - dy
    y = bottom - Math.max(h, WINDOW_MIN_H)
  }
  w = Math.max(w, WINDOW_MIN_W)
  h = Math.max(h, WINDOW_MIN_H)
  // The top edge may not be dragged above the banner: grow downward instead of moving up.
  if (y < vp.topInset) {
    h = Math.max(WINDOW_MIN_H, bottom - vp.topInset)
    y = vp.topInset
  }
  return clampBox({ x, y, w, h }, vp)
}

/** Where a new window opens: staggered so a second one never hides the first completely. */
export function nextOpenBox(existing: WindowEntry[], vp: Viewport): WindowBox {
  const step = 36
  const n = existing.length
  const w = Math.min(WINDOW_DEFAULT_W, Math.max(WINDOW_MIN_W, vp.vw - 80))
  const h = Math.min(WINDOW_DEFAULT_H, Math.max(WINDOW_MIN_H, vp.vh - vp.topInset - 60))
  const x = Math.round((vp.vw - w) / 2) + (n - 1) * step
  const y = vp.topInset + 28 + n * step
  return clampBox({ x, y, w, h }, vp)
}

// ───────────────────────────── state changes ─────────────────────────────

export type OpenResult =
  | { ok: true; state: WindowsState; id: string; reused: boolean }
  | { ok: false; reason: 'bad_url' | 'cap'; state: WindowsState }

/** Explicit narrowing: the project's TypeScript is not strict, so `!r.ok` alone does not narrow. */
export function isOpenFailure(r: OpenResult): r is Extract<OpenResult, { ok: false }> {
  return r.ok === false
}

function newId(state: WindowsState): string {
  // Not security-relevant; just unique within a session and stable across a reload of storage.
  const used = new Set(state.windows.map(w => w.id))
  for (let i = state.topZ + 1; ; i++) {
    const id = `w${i}`
    if (!used.has(id)) return id
  }
}

/** Open a page in a window. The same page already open is brought to the front, not duplicated. */
export function openWindow(state: WindowsState, url: unknown, title: string | undefined, vp: Viewport): OpenResult {
  if (!isWindowableUrl(url)) return { ok: false, reason: 'bad_url', state }
  const dup = state.windows.find(w => sameWindowPage(w.url, url))
  if (dup) {
    const next = focusWindow(restoreWindow(state, dup.id), dup.id)
    return { ok: true, state: next, id: dup.id, reused: true }
  }
  if (state.windows.length >= MAX_WINDOWS) return { ok: false, reason: 'cap', state }
  const id = newId(state)
  const topZ = state.topZ + 1
  const entry: WindowEntry = {
    id,
    url,
    title: (title && title.trim()) || fallbackTitle(url),
    minimized: false,
    z: topZ,
    ...nextOpenBox(state.windows, vp),
  }
  return { ok: true, state: { windows: [...state.windows, entry], topZ }, id, reused: false }
}

export function closeWindow(state: WindowsState, id: string): WindowsState {
  if (!state.windows.some(w => w.id === id)) return state
  return { ...state, windows: state.windows.filter(w => w.id !== id) }
}

export function focusWindow(state: WindowsState, id: string): WindowsState {
  const target = state.windows.find(w => w.id === id)
  if (!target) return state
  if (state.windows.every(w => w.id === id || w.z < target.z)) return state // already in front
  const topZ = Math.max(state.topZ, ...state.windows.map(w => w.z)) + 1
  return { windows: state.windows.map(w => (w.id === id ? { ...w, z: topZ } : w)), topZ }
}

export function minimizeWindow(state: WindowsState, id: string): WindowsState {
  return patch(state, id, { minimized: true })
}

export function restoreWindow(state: WindowsState, id: string): WindowsState {
  return patch(state, id, { minimized: false })
}

export function setBox(state: WindowsState, id: string, box: WindowBox): WindowsState {
  return patch(state, id, box)
}

/** The page inside a window navigated: remember where it is now and what it is called. */
export function setLocation(state: WindowsState, id: string, url: string, title: string): WindowsState {
  if (!isWindowableUrl(url)) return state
  const cur = state.windows.find(w => w.id === id)
  if (!cur) return state
  // Most CRM pages are simply titled "TD Operations" — useless on a window; use the page name instead.
  const t = title.trim()
  const generic = !t || t === 'TD Operations'
  // A name the opener chose ("Acme Holdings LLC", from search) beats the generic page name while the
  // window stays inside the same section of the CRM.
  const rootOf = (u: string) => pathOf(u).split('/')[1] ?? ''
  const keepChosen = cur.title !== fallbackTitle(cur.url) && rootOf(cur.url) === rootOf(url)
  const nextTitle = !generic ? t : keepChosen ? cur.title : fallbackTitle(url)
  if (cur.url === url && cur.title === nextTitle) return state
  return patch(state, id, { url, title: nextTitle })
}

/** After a screen-size change, pull every window back into view. */
export function clampAll(state: WindowsState, vp: Viewport): WindowsState {
  let changed = false
  const windows = state.windows.map(w => {
    const b = clampBox(w, vp)
    if (b.x === w.x && b.y === w.y && b.w === w.w && b.h === w.h) return w
    changed = true
    return { ...w, ...b }
  })
  return changed ? { ...state, windows } : state
}

function patch(state: WindowsState, id: string, change: Partial<WindowEntry>): WindowsState {
  if (!state.windows.some(w => w.id === id)) return state
  return { ...state, windows: state.windows.map(w => (w.id === id ? { ...w, ...change } : w)) }
}

/** The window that is in front of all the others (ignoring minimised ones). */
export function frontWindowId(state: WindowsState): string | null {
  const open = state.windows.filter(w => !w.minimized)
  if (open.length === 0) return null
  return open.reduce((a, b) => (b.z > a.z ? b : a)).id
}

// ───────────────────────────── remembering ─────────────────────────────

const STORAGE_PREFIX = 'td-windows-v1:'

/** One key per signed-in person, so a shared computer never shows someone else's windows. */
export function storageKeyFor(userId: string): string {
  return STORAGE_PREFIX + userId
}

export function isWindowsStorageKey(key: string): boolean {
  return key.startsWith(STORAGE_PREFIX)
}

export function serializeState(state: WindowsState): string {
  return JSON.stringify({
    v: 1,
    windows: state.windows.map(w => ({
      url: w.url, title: w.title, minimized: w.minimized, z: w.z, x: w.x, y: w.y, w: w.w, h: w.h,
    })),
  })
}

/**
 * Turn what was stored into a safe state. Anything wrong — bad JSON, a foreign address, too many
 * windows, nonsense numbers — is dropped or repaired, never trusted: storage can be hand-edited
 * and an address saved last week must pass today's rules again.
 */
export function parseState(raw: string | null, vp: Viewport): WindowsState {
  if (!raw) return EMPTY_STATE
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return EMPTY_STATE
  }
  const list = (data as { windows?: unknown })?.windows
  if (!Array.isArray(list)) return EMPTY_STATE
  const seen: string[] = []
  const entries: WindowEntry[] = []
  for (const item of list) {
    if (entries.length >= MAX_WINDOWS) break
    const o = item as Record<string, unknown> | null
    if (!o || typeof o !== 'object') continue
    if (!isWindowableUrl(o.url)) continue
    const url = o.url as string
    if (seen.some(s => sameWindowPage(s, url))) continue
    seen.push(url)
    const box = clampBox(
      { x: finite(o.x, 0), y: finite(o.y, vp.topInset), w: finite(o.w, WINDOW_DEFAULT_W), h: finite(o.h, WINDOW_DEFAULT_H) },
      vp,
    )
    entries.push({
      id: '',
      url,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 120) : fallbackTitle(url),
      minimized: o.minimized === true,
      z: finite(o.z, 0),
      ...box,
    })
  }
  // Re-number ids and stacking so they are small, unique and in the stored order.
  const ordered = [...entries].sort((a, b) => a.z - b.z)
  const windows = entries.map(e => ({ ...e, id: `w${entries.indexOf(e) + 1}`, z: ordered.indexOf(e) + 1 }))
  return { windows, topZ: windows.length }
}
