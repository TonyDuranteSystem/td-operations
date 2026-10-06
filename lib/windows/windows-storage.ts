/**
 * Where windows are remembered (this browser only), kept per signed-in person.
 *
 * Every function takes the storage as an argument and swallows its errors: private windows and
 * blocked site data can make localStorage throw, and the CRM must work identically without it.
 * Pure of any DOM so it is unit-tested with a fake storage (R086).
 */

import {
  EMPTY_STATE, isWindowsStorageKey, parseState, serializeState, storageKeyFor,
  type Viewport, type WindowsState,
} from '@/lib/windows/window-model'

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

function allWindowKeys(store: KeyValueStore): string[] {
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)
    if (k && isWindowsStorageKey(k)) keys.push(k)
  }
  return keys
}

export function loadWindows(store: KeyValueStore | null, userId: string, vp: Viewport): WindowsState {
  try {
    return parseState(store?.getItem(storageKeyFor(userId)) ?? null, vp)
  } catch {
    return EMPTY_STATE
  }
}

export function saveWindows(store: KeyValueStore | null, userId: string, state: WindowsState): void {
  try {
    if (state.windows.length === 0) store?.removeItem(storageKeyFor(userId))
    else store?.setItem(storageKeyFor(userId), serializeState(state))
  } catch { /* storage unavailable — windows just are not remembered */ }
}

/**
 * Remove every remembered window set that does NOT belong to `userId`. Run on start, so a shared
 * computer never shows (or keeps) another person's windows, whatever way they signed out — an
 * expired session, an admin ban and a reset all end a session without passing through the Sign-out
 * button.
 */
export function pruneOtherUsers(store: KeyValueStore | null, userId: string): void {
  try {
    if (!store) return
    const mine = storageKeyFor(userId)
    for (const k of allWindowKeys(store)) if (k !== mine) store.removeItem(k)
  } catch { /* ignore */ }
}

/** Forget every remembered window set (used at sign-out). */
export function clearAllWindows(store: KeyValueStore | null): void {
  try {
    if (!store) return
    for (const k of allWindowKeys(store)) store.removeItem(k)
  } catch { /* ignore */ }
}

/** The real browser storage, or null when it is unavailable. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
