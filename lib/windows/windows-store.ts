/**
 * A tiny read-only mirror of "which windows exist right now", kept by the window manager and read by the
 * guided tour (dev job f3f3e237). Module-level so the tour does not need to be a child of the manager,
 * and exposed as a subscribable store so React re-renders only when something the tour cares about changes.
 */

import { useSyncExternalStore } from 'react'

export interface WindowsSnapshot {
  /** The manager has loaded this person's windows and is drawing (false below desktop width / before start). */
  ready: boolean
  count: number
  ids: string[]
  /** The window in front of the others (not a minimised one), or null. */
  frontId: string | null
  /** Ids currently minimised. */
  minimized: string[]
  /** Pages open, in the same order as `ids` (path + query) — lets a step recognise "Accounts" vs "Leads". */
  urls: string[]
}

export const EMPTY_SNAPSHOT: WindowsSnapshot = { ready: false, count: 0, ids: [], frontId: null, minimized: [], urls: [] }

let current: WindowsSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function snapshotsEqual(a: WindowsSnapshot, b: WindowsSnapshot): boolean {
  return a.ready === b.ready && a.count === b.count && a.frontId === b.frontId
    && sameList(a.ids, b.ids) && sameList(a.minimized, b.minimized) && sameList(a.urls, b.urls)
}

/** Replace the snapshot; subscribers are told only when something really changed. */
export function setWindowsSnapshot(next: WindowsSnapshot): void {
  if (snapshotsEqual(current, next)) return
  current = next
  listeners.forEach(l => l())
}

export function getWindowsSnapshot(): WindowsSnapshot {
  return current
}

export function subscribeWindows(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWindowsSnapshot(): WindowsSnapshot {
  return useSyncExternalStore(subscribeWindows, getWindowsSnapshot, () => EMPTY_SNAPSHOT)
}
