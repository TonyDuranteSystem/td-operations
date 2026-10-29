/**
 * TD Marketing — the floating lead windows (pure; dev job 9aec66fa, Addendum G). Clicking a lead on the board opens it in a window on top of the board instead of a new page.
 * The rules: at most three at once (a fourth closes the oldest), a window can be minimized to the bottom bar and brought back, closed, moved; the one you touch comes to the
 * front. Positions are kept inside the screen. No DOM here, so every rule is tested without a browser.
 */
export const MAX_WINDOWS = 3
export const WINDOW_W = 560
export const WINDOW_H = 680
export const TITLEBAR_H = 40
export const DOCK_H = 44
/** the message a lead window sends to the board when something on the lead was saved */
export const FRAME_CHANGED = "tdm-lead-changed"

/** "chat" opens the lead's chat tab (the first of the person's chats); "chat:owners" / "chat:setter" open that one of the lead's two chats (Antonio and Rocco / Rocco and the setter). */
export type WindowTab = "lead" | "chat" | "chat:owners" | "chat:setter"
/** The lane a window tab names, or null for "lead" and plain "chat". */
export const laneOfTab = (tab: string | undefined | null): "owners" | "setter" | null => (tab === "chat:owners" ? "owners" : tab === "chat:setter" ? "setter" : null)
export const isChatTab = (tab: string | undefined | null): boolean => tab === "chat" || laneOfTab(tab) !== null
/** `tab` = the tab the person last asked for; `srcTab` = the tab the window's page was opened on (never changes, so the page inside is never reloaded and nothing typed is lost). */
export interface LeadWindow { id: string; name: string; minimized: boolean; x: number; y: number; z: number; tab: WindowTab; srcTab: WindowTab }
export interface Viewport { w: number; h: number }
export interface WindowsState { list: LeadWindow[]; topZ: number }
export const EMPTY_WINDOWS: WindowsState = { list: [], topZ: 1 }

/** Keep the title bar reachable: the window may leave the screen a little, but never so far that it cannot be grabbed. */
export function clampPosition(x: number, y: number, vp: Viewport): { x: number; y: number } {
  const maxX = Math.max(0, vp.w - 120)
  const maxY = Math.max(0, vp.h - DOCK_H - TITLEBAR_H)
  return { x: Math.min(Math.max(-(WINDOW_W - 120), Math.round(x)), maxX), y: Math.min(Math.max(0, Math.round(y)), maxY) }
}

/** Open a lead: an open one just comes to the front (and out of the bar); a new one is placed a little lower than the last, and the oldest closes when there are already three. */
export function openWindow(s: WindowsState, lead: { id: string; name: string; tab?: WindowTab }, vp: Viewport): WindowsState {
  const topZ = s.topZ + 1
  const existing = s.list.find(w => w.id === lead.id)
  if (existing) return { topZ, list: s.list.map(w => (w.id === lead.id ? { ...w, minimized: false, z: topZ, name: lead.name || w.name, tab: lead.tab ?? w.tab } : w)) }
  let list = s.list
  if (list.length >= MAX_WINDOWS) {
    const oldest = list.reduce((a, b) => (a.z <= b.z ? a : b))
    list = list.filter(w => w.id !== oldest.id)
  }
  const n = list.length
  const start = clampPosition(Math.round((vp.w - WINDOW_W) / 2) + n * 28 - 28, 72 + n * 28, vp)
  return { topZ, list: [...list, { id: lead.id, name: lead.name, minimized: false, x: start.x, y: start.y, z: topZ, tab: lead.tab ?? "lead", srcTab: lead.tab ?? "lead" }] }
}

export function focusWindow(s: WindowsState, id: string): WindowsState {
  const topZ = s.topZ + 1
  return { topZ, list: s.list.map(w => (w.id === id ? { ...w, z: topZ } : w)) }
}
export function minimizeWindow(s: WindowsState, id: string): WindowsState {
  return { ...s, list: s.list.map(w => (w.id === id ? { ...w, minimized: true } : w)) }
}
export function closeWindow(s: WindowsState, id: string): WindowsState {
  return { ...s, list: s.list.filter(w => w.id !== id) }
}
export function moveWindow(s: WindowsState, id: string, x: number, y: number, vp: Viewport): WindowsState {
  const p = clampPosition(x, y, vp)
  return { ...s, list: s.list.map(w => (w.id === id ? { ...w, x: p.x, y: p.y } : w)) }
}
/** The window in front (the highest, not minimized), or null. */
export function frontWindowId(s: WindowsState): string | null {
  const open = s.list.filter(w => !w.minimized)
  return open.length ? open.reduce((a, b) => (a.z >= b.z ? a : b)).id : null
}
/** A window page address: only a lead id that is a plain uuid is ever put in an address. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isLeadId = (id: string): boolean => UUID.test(id)
export function windowSrc(id: string, tab: WindowTab = "lead", role?: string): string | null {
  if (!UUID.test(id)) return null
  const q = new URLSearchParams()
  if (isChatTab(tab)) q.set("tab", tab)
  if (role === "setter" || role === "seller") q.set("role", role)
  const s = q.toString()
  return `/marketing/window/${id.toLowerCase()}${s ? `?${s}` : ""}`
}
/** What the board tells a window page to do when its lead is opened again from a notification or the Messages list. */
export const OPEN_TAB_MESSAGE = "tdm-open-tab"
/** What the board tells a window page about itself: `hidden` = minimized or behind another window (so its chat does not mark messages read). */
export const WINDOW_STATE_MESSAGE = "tdm-window-state"
/** What a window page tells the board when the person clicks inside it: bring this window to the front. */
export const FRAME_FOCUS = "tdm-frame-focus"
