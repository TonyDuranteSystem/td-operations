'use client'

/**
 * Docks a floating launcher mostly past its nearest screen edge while idle,
 * leaving a small tappable sliver — Antonio: "hidden for 3/4 on the side of the
 * screen and recall them when needed" (2026-09-09, dev job b85fe89e).
 *
 * Deliberately NOT built into useDraggableFab — see lib/ui/edge-dock.ts's own
 * header for why layering this into that hook's stored position/clamp pipeline
 * breaks on the mobile keyboard opening and silently drops data on save. This
 * hook only ever READS a caller's `pos` (from useDraggableFab) to decide which
 * edge to fold toward; it never touches that hook's state or storage.
 *
 * Docked is the ALWAYS resting state for a mounted launcher — both callers only
 * ever render this button while their panel is closed in the first place, so
 * there is no separate "closed but revealed" state to track. Tapping the button
 * performs whatever it already does today (open the sheet / open the chat) —
 * docking never gates or changes that; it is a purely visual resting posture,
 * not a two-step reveal-then-open flow (Erika-Hall-UX-Designer, Council review:
 * a required extra tap on these exact buttons already cost real missed taps
 * once this exact week). There is deliberately no auto-reveal-on-alert or
 * auto-re-dock-on-acknowledge either — four independent reviewers each found a
 * real problem with that idea from a different angle; the color/blink a note or
 * an unread chat already carries renders through the docked sliver exactly as
 * it does fully revealed, so urgency is still visible without any bubble motion.
 *
 * The double-tap/double-click RESET this shares with useDraggableFab is the one
 * exception: `revealPermanently` must be wired to fire alongside it, because
 * making "docked" the default resting state would otherwise quietly disable the
 * one existing recovery path for a button stuck somewhere unreachable (bug-
 * hunter blocker — reset used to always land on a guaranteed-visible spot; once
 * docked is the default, "reset" alone no longer guarantees that). Once
 * triggered it holds for the rest of this page load — simple on purpose, since
 * nothing about the docked state can actually strand the button anymore (the
 * shift is a fixed pixel floor, never a fraction that could zero out).
 */

import { useCallback, useEffect, useState, type RefObject } from 'react'
import { nearestDockEdge, dockPositionStyle, type DockEdge } from '@/lib/ui/edge-dock'

export function useEdgeDock<T extends HTMLElement>(
  ref: RefObject<T | null>,
  opts: {
    /** Which edge an untouched (never-dragged) bubble docks toward. */
    defaultEdge: DockEdge
    /** The caller's own useDraggableFab position — read-only, never written. */
    pos: { x: number } | null
    minVisiblePx?: number
    /**
     * Pass a value that changes once the button's own CONTENT (not the
     * viewport) is done settling — e.g. a note count that starts at a loading
     * placeholder and flips once the real data arrives. Same shape and same
     * reason as useDraggableFab's own `remeasureOn`: caught live, not in
     * review, that a plain ResizeObserver on the element did NOT reliably
     * re-fire once the mobile notes pill's label switched from the wider
     * "Notes" placeholder to a narrower real count — the very first
     * measurement (taken while still showing "Notes") won and never
     * corrected, silently pushing the whole pill off-screen with nothing
     * left visible. Re-running the measurement explicitly when the thing
     * that actually changes the label changes is a fact this hook cannot
     * infer on its own; it must be told. Optional, so a caller whose label
     * never changes (the chat launcher, the desktop compose button) needs no
     * changes and behaves exactly as before.
     */
    remeasureOn?: unknown
  },
) {
  const [forceRevealed, setForceRevealed] = useState(false)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      if (w && w > 0) setWidth(w)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.remeasureOn])

  const edge = nearestDockEdge(opts.pos, opts.defaultEdge)
  const docked = !forceRevealed
  const position = docked ? dockPositionStyle(edge, width, opts.minVisiblePx) : undefined

  /** The escape hatch — pair with useDraggableFab's own `reset` on the same
   *  double-click/double-tap so a stuck button always has ONE guaranteed way
   *  back to fully visible, not just back to its (still-docked) default corner. */
  const revealPermanently = useCallback(() => setForceRevealed(true), [])

  return {
    docked,
    /** Spread into the button's own style object, AFTER useDraggableFab's own
     *  `style` — an absolute left/right override, so it always wins outright
     *  over that hook's own left/right (moved) or the button's default CSS
     *  classes (untouched), rather than fighting either. Undefined when
     *  there's nothing to shift, so it never overrides a caller's style
     *  unnecessarily.
     *
     *  Deliberately NO CSS transition on left/right here — caught live, not in
     *  review: this component re-renders often enough (a 60s alerts poll alone)
     *  that a transition on these two properties never reliably finished
     *  animating before the next render restarted it from scratch, which left
     *  the button PERMANENTLY stuck at its pre-dock position with no visible
     *  error — the position only ever "moved" instantly, the one time nothing
     *  interrupted the animation before the browser had rendered even a single
     *  frame of progress. An instant snap has no such failure mode. */
    dockStyle: position,
    revealPermanently,
  }
}
