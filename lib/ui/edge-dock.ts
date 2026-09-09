/**
 * Edge-docking geometry for the two staff floating launchers (the notes button,
 * the team-chat launcher) — kept pure and testable, same split as draggable-fab.ts.
 *
 * DELIBERATELY SEPARATE from draggable-fab.ts / useDraggableFab's own stored
 * position + clamp pipeline — this is not an extension of that system, it is a
 * second, independent visual layer applied on top of it. A council review (dev
 * job b85fe89e) found the naive approach — folding a "docked" offset into the
 * SAME stored fraction useDraggableFab already clamps — breaks two ways: (1) the
 * resize/orientationchange listener that already exists specifically to react to
 * the mobile keyboard opening unconditionally re-clamps that fraction back into
 * the fully-visible range, silently un-docking the button on the single most
 * common phone interaction there is; (2) the low-level storage read/write
 * functions hardcode the stored shape to exactly {x, y}, so a "docked" flag
 * saved the obvious way would be silently discarded on every load, forever.
 * Living in a separate module/hook that only ever READS useDraggableFab's
 * position (to decide which edge to fold toward) and never writes to its
 * storage or state sidesteps both — the underlying drag/clamp system runs
 * exactly as it does today, completely unaware docking exists.
 */

export type DockEdge = 'left' | 'right'

/**
 * Which screen edge a bubble should fold toward. An untouched bubble (pos ===
 * null — see useDraggableFab) always uses its own designed default corner; only
 * a bubble the user has actually dragged needs a computed answer, based on
 * which half of the screen its LEFT edge currently sits in. Deliberately a
 * coarse left-edge-fraction check, not a precise centre-of-mass calculation —
 * docking only needs "which side is this roughly on," not exact geometry.
 */
export function nearestDockEdge(pos: { x: number } | null, defaultEdge: DockEdge): DockEdge {
  if (pos == null) return defaultEdge
  return pos.x < 0.5 ? 'left' : 'right'
}

/** Never dock tighter than this many px stay visible — a floor over the visual
 *  ratio, not a target: Council review (Erika-Hall-UX-Designer, bug-hunter) found
 *  a flat "1/4 visible" ratio gives an unusably thin sliver on a small bubble,
 *  and a circle's exposed strip tapers toward nothing above/below its own
 *  vertical centre — a flat pixel floor sidesteps both. Lowered from 32 to 16
 *  (Antonio, after trying the first version live: "put them even more hidden")
 *  — safe to go this low because the button's actual clickable area is never
 *  reduced to match (see useEdgeDock's hover-reveal), only the visible paint. */
export const MIN_VISIBLE_PX = 16

/**
 * The inline position override that pushes a bubble mostly past its nearest
 * edge, leaving `minVisiblePx` of it showing on-screen. Returns undefined when
 * there's nothing to shift (width not yet measured, or the bubble is already
 * narrower than the visible floor — nothing to hide).
 *
 * ABSOLUTE, not relative: `left`/`right` set directly from the viewport edge
 * (e.g. `left: -24px` hides everything left of x=0), never a `transform`
 * computed from the bubble's CURRENT rendered position. A transform-based
 * shift was tried first and measured wrong live — both launchers already sit
 * with a real margin from the true screen edge (their own `left-4`/`right-4`
 * spacing), so "shift by (width - minVisible)" from THAT position left far
 * more than minVisiblePx on screen instead of the intended sliver. An absolute
 * value has no such dependency: it fully determines the final position by
 * itself, regardless of whatever margin the button's own CSS or a past drag
 * already put it at. Always returns BOTH keys (one real value, one `'auto'`)
 * so it can safely override whichever axis useDraggableFab's own `style` (or
 * the button's default CSS classes) had set, without stretching the element
 * by leaving conflicting `left` and `right` both active at once.
 */
export function dockPositionStyle(
  edge: DockEdge,
  widthPx: number | null,
  minVisiblePx: number = MIN_VISIBLE_PX,
): { left: string; right: string } | undefined {
  if (widthPx == null || !Number.isFinite(widthPx)) return undefined
  const shift = Math.max(0, widthPx - minVisiblePx)
  if (shift <= 0) return undefined
  return edge === 'left'
    ? { left: `-${shift}px`, right: 'auto' }
    : { left: 'auto', right: `-${shift}px` }
}

/**
 * How far past the true viewport edge a hover/pointer reveal should land —
 * 0, always, and this value is load-bearing, not cosmetic.
 *
 * A FIRST hover-reveal attempt (2026-09-09) reverted to each button's own
 * "natural" resting spot (its plain CSS default corner, e.g. 1rem inset) and
 * froze/strobed the screen live, on a real phone, within the hour. Root cause,
 * worked out AFTER the incident, not before: the docked sliver is always
 * anchored flush at the true edge (dockPositionStyle above guarantees the
 * visible range starts at exactly 0), but "natural" position starts SEVERAL
 * pixels further in (e.g. 16px). Revealing to that inset spot means the
 * button's own near edge sweeps PAST wherever a finger or cursor was already
 * resting in the docked sliver (anywhere from 0 up to the visible floor) —
 * the moment that happens, the pointer is no longer over the button, hover
 * drops, it docks again, which puts the sliver back under the pointer,
 * re-triggering the reveal. A closed loop, many times a second.
 *
 * The fix is geometric, not a debounce or a bigger hit-area hack: reveal
 * flush at the SAME edge the docked sliver already starts from (0), not the
 * button's inset resting spot. Since the docked range is always [0,
 * minVisiblePx] and the revealed range is always [0, fullWidth], and
 * minVisiblePx is never wider than fullWidth (dockPositionStyle already
 * guarantees that — see its own `shift <= 0` guard), the docked range is
 * always a SUBSET of the revealed range. Any point already under the pointer
 * before the reveal is therefore, by construction, still under the button
 * after it — the pointer can never be swept out from under itself, so the
 * loop this constant exists to prevent cannot occur regardless of exactly
 * how or when hover triggers (real mouse, touch's own inconsistent hover
 * emulation, or anything else an unverified assumption might have missed —
 * the FIRST attempt's own comment claimed "touch has no sustained hover to
 * trigger this," asserted rather than checked, and touch reproduced the
 * freeze directly on Antonio's phone).
 *
 * Do not change this to a nonzero inset without re-deriving the same proof —
 * a value greater than 0 reopens exactly this hazard for any pointer
 * position closer to the edge than that inset.
 */
export const HOVER_REVEAL_PX = 0

/**
 * The Tailwind utility that reveals a docked bubble flush at its edge on
 * hover, strong enough to win over the docked state's own inline style —
 * inline styles always beat a plain class, so only an `!important` class
 * rule can override one. Centralized here, not hand-typed at each of the
 * three call sites, so this stays the one place that decides it.
 *
 * Deliberately a STATIC string literal per branch, never built from
 * HOVER_REVEAL_PX with a template (e.g. `` `hover:!left-[${HOVER_REVEAL_PX}px]` ``)
 * — caught before it ever shipped, not live: Tailwind's build-time scanner
 * finds classes by reading the literal TEXT of source files, without
 * evaluating any JavaScript. A template-built class name never appears as
 * that literal text anywhere (the file would only ever contain the
 * `${...}` syntax itself), so Tailwind would silently never generate the
 * CSS rule for whatever the template actually resolves to at runtime — the
 * class would be applied to the element and do precisely nothing, with no
 * error anywhere. `left-0`/`right-0` both already mean exactly 0 in
 * Tailwind's own default scale, so a plain, static, already-existing
 * utility is both simpler and the only version that actually works.
 */
export function hoverRevealClass(edge: DockEdge): string {
  return edge === 'left' ? 'hover:!left-0' : 'hover:!right-0'
}
