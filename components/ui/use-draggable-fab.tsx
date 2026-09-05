'use client'

/**
 * Makes a floating button (or, generically, any element — see the type
 * parameter below) draggable — desktop and touch.
 *
 * One hook, used by the green chat launcher and the amber notes pill, so the
 * two behave identically and a fix lands in both. Also reused (2026-09-04,
 * Antonio: "can the popup page be moved?") as the drag handle for the My
 * Captures popup's header bar — a <div>, not a <button> — via the generic
 * type parameter (`useDraggableFab<HTMLDivElement>(key)`), which defaults to
 * `HTMLButtonElement` so neither existing caller needed a single change.
 *
 * The three things that make touch-dragging a button safe, all handled here:
 *
 *  1. A TAP MUST STAY A TAP. Movement under the threshold is not a drag, and the
 *     button's own onClick still fires. Past the threshold we suppress the click
 *     so that letting go after a drag does not also open the thing you moved.
 *  2. DRAGGING MUST NOT SCROLL THE PAGE. Pointer capture keeps the gesture even
 *     when the finger outruns a 56px target, and the caller sets touch-action:none
 *     so the browser does not hand the gesture to the scroller instead.
 *  3. THE BUTTON MUST STAY REACHABLE. Every position is clamped against the
 *     element's measured box, and a double-click/tap resets to the default corner
 *     — the escape hatch for a button parked somewhere useless.
 *
 * Returns null for `style` until the user has actually moved the button, so an
 * untouched button keeps its CSS corner and its responsive classes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampFabPos, isDragGesture, readStoredFabPos, serializeFabPos,
  type FabPos,
} from '@/lib/ui/draggable-fab'

/** localStorage, wrapped — a throwing or full store must never break a button. */
const store = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string) {
    try { window.localStorage.setItem(key, value) } catch { /* private mode / quota */ }
  },
  remove(key: string) {
    try { window.localStorage.removeItem(key) } catch { /* ignore */ }
  },
}

export function useDraggableFab<T extends HTMLElement = HTMLButtonElement>(storageKey: string) {
  const ref = useRef<T | null>(null)
  const [pos, setPos] = useState<FabPos | null>(null)
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null)
  /**
   * Click suppression MUST be a ref, not state.
   *
   * The consumer reads this inside its onClick. React state is captured per
   * render, so the click that follows a drag can read a STALE `false` and open
   * the thing you were only trying to move — verified happening on sandbox
   * before this was changed. A ref is read at call time, so it is always current.
   */
  const suppressClick = useRef(false)
  const [, forceRender] = useState(0)

  // Read stored position AFTER mount — reading storage during render desyncs
  // hydration.
  useEffect(() => {
    const stored = readStoredFabPos(store.get(storageKey))
    if (!stored) return
    const box = ref.current?.getBoundingClientRect()
    setPos(clampFabPos(stored, {
      vw: window.innerWidth, vh: window.innerHeight, w: box?.width, h: box?.height,
    }))
  }, [storageKey])

  // Keep it on screen when the viewport changes under it (rotation, resize,
  // the mobile keyboard opening).
  useEffect(() => {
    const onResize = () => {
      setPos((p) => {
        if (!p) return p
        const box = ref.current?.getBoundingClientRect()
        return clampFabPos(p, {
          vw: window.innerWidth, vh: window.innerHeight, w: box?.width, h: box?.height,
        })
      })
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<T>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    drag.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    }
    // Keep receiving moves even if the finger leaves the button.
    try { el.setPointerCapture(e.pointerId) } catch { /* not all pointers capture */ }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<T>) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && !isDragGesture(e.clientX - d.startX, e.clientY - d.startY)) return
    if (!d.moved) { d.moved = true; suppressClick.current = true; forceRender((n) => n + 1) }
    const box = ref.current?.getBoundingClientRect()
    setPos(clampFabPos(
      { x: (e.clientX - d.dx) / window.innerWidth, y: (e.clientY - d.dy) / window.innerHeight },
      { vw: window.innerWidth, vh: window.innerHeight, w: box?.width, h: box?.height },
    ))
  }, [])

  const endDrag = useCallback(() => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) { suppressClick.current = false; return }
    setPos((p) => { if (p) store.set(storageKey, serializeFabPos(p)); return p })
    // Stay suppressed for one tick so the click that FOLLOWS this drag is
    // swallowed — otherwise dropping the button also activates it.
    setTimeout(() => { suppressClick.current = false }, 0)
  }, [storageKey])

  /** Put it back in its default corner. */
  const reset = useCallback(() => {
    store.remove(storageKey)
    setPos(null)
  }, [storageKey])

  return {
    ref,
    /**
     * True while a real drag is in progress or has just finished — the consumer
     * MUST check this in its onClick. A getter, not a captured value, so it
     * cannot go stale between render and click.
     */
    get dragging() { return suppressClick.current },
    /** Spread onto the button. */
    dragProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: reset,
    },
    /** null until moved, so the button keeps its CSS default corner. */
    style: pos ? { left: `${pos.x * 100}vw`, top: `${pos.y * 100}vh`, right: 'auto', bottom: 'auto' } : undefined,
    reset,
    hasMoved: pos !== null,
  }
}
