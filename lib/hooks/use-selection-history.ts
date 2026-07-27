'use client'

import { useEffect, useRef } from 'react'
import { markInAppNavigation } from '@/lib/nav/in-app-history'

/**
 * Make an IN-PAGE selection (which chat / which thread you're looking at) a real
 * browser history step, so the global Back arrow returns to the PREVIOUS
 * SELECTION instead of jumping out to the last full page.
 *
 * Why this exists (Antonio, 2026-07-26): "I click on one chat in portal chat,
 * and then I change chat, and then I hit the arrow to go back. It goes to home
 * dashboard." Portal Chats and Team Chat both pick a conversation with plain
 * React state and never touch the URL, so the browser has no record of those
 * moves — Back correctly skips to the last real navigation, which is usually the
 * dashboard. Recording the selection in the query string fixes that at the root
 * and, as a bonus, makes a conversation shareable by link.
 *
 * Mechanism: `window.history.pushState` (NOT `router.push`). Next 14.1+ supports
 * the native History API and keeps the App Router in sync WITHOUT a server
 * round-trip or a re-render of the route — so switching chats stays instant and
 * refetches nothing. `router.push` would re-run the route and is the wrong tool
 * for a purely client-side selection.
 *
 * The decision logic lives in the exported pure helpers below so it is unit
 * tested (this repo has no React test renderer); the hook is a thin shell.
 */
export type SelectionValues = Record<string, string | null | undefined>

/** Stable content signature for a selection — order-independent. */
export function serializeSelection(values: SelectionValues): string {
  return Object.keys(values)
    .sort()
    .map(k => `${k}=${values[k] ?? ''}`)
    .join('&')
}

/**
 * Write the owned keys onto a URL. Empty/null values are REMOVED (an absent
 * selection must not linger as `?account=` in the address). Keys this page does
 * not own are preserved untouched.
 */
export function applySelectionToUrl(href: string, values: SelectionValues): string {
  const url = new URL(href)
  for (const k of Object.keys(values)) {
    const v = values[k]
    if (v) url.searchParams.set(k, v)
    else url.searchParams.delete(k)
  }
  return url.href
}

/** Read the owned keys back out of a URL (missing → null). */
export function parseSelectionFromUrl(href: string, keys: string[]): Record<string, string | null> {
  const sp = new URL(href).searchParams
  return Object.fromEntries(keys.map(k => [k, sp.get(k)]))
}

/**
 * @param values     the keys this page owns, e.g. { account, contact, thread }.
 * @param onRestore  called on Back/Forward with the values parsed from the URL
 *                   the browser moved to. Apply them to your state; do NOT push
 *                   from inside it (the hook suppresses the echo).
 *
 * Guarantees: never pushes on first mount (that would duplicate the entry you
 * arrived on); never pushes when the change came FROM a Back/Forward (no
 * ping-pong); never stacks an entry when the resulting URL is identical (that
 * would make the user press Back twice for one move).
 */
export function useSelectionHistory(
  values: SelectionValues,
  onRestore: (values: Record<string, string | null>) => void,
) {
  const onRestoreRef = useRef(onRestore)
  useEffect(() => { onRestoreRef.current = onRestore }, [onRestore])

  // The selection currently reflected in the URL.
  const appliedRef = useRef<string | null>(null)
  const keysRef = useRef<string[]>(Object.keys(values))
  keysRef.current = Object.keys(values)
  const valuesRef = useRef<SelectionValues>(values)
  valuesRef.current = values

  const serialized = serializeSelection(values)

  useEffect(() => {
    // First run: adopt whatever we arrived with — no push.
    if (appliedRef.current === null) { appliedRef.current = serialized; return }
    if (appliedRef.current === serialized) return
    appliedRef.current = serialized
    try {
      const next = applySelectionToUrl(window.location.href, valuesRef.current)
      if (next === window.location.href) return
      window.history.pushState(null, '', next)
      // Tell the global Back arrow this counts as a move. It cannot infer it:
      // the pathname is unchanged, only the query moved. Without this, Back
      // sees "no in-app history" and goes home — the exact bug this fixes.
      markInAppNavigation()
    } catch {
      /* History API unavailable — selection still works, just no Back step. */
    }
    // `values` is a fresh object literal every render; `serialized` is its
    // stable content signature and the correct trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized])

  useEffect(() => {
    const onPop = () => {
      let parsed: Record<string, string | null>
      try {
        parsed = parseSelectionFromUrl(window.location.href, keysRef.current)
      } catch {
        parsed = Object.fromEntries(keysRef.current.map(k => [k, null]))
      }
      // Mark applied BEFORE handing to the caller, so the state update it
      // triggers is seen as "already in the URL" and is not pushed back.
      appliedRef.current = serializeSelection(parsed)
      onRestoreRef.current(parsed)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
}
