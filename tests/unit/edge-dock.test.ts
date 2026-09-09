/**
 * Edge-docking geometry for the two staff floating launchers — kept pure so the
 * position math is pinned without a DOM. See lib/ui/edge-dock.ts's own header
 * for why this is a separate module from draggable-fab.ts, not an extension of
 * it, and why it computes an ABSOLUTE left/right override rather than a
 * transform (a transform-based version was tried first and measured wrong
 * live — both launchers already sit with a real margin from the true screen
 * edge, which a relative shift doesn't know about).
 */
import { describe, it, expect } from 'vitest'
import { nearestDockEdge, dockPositionStyle, hoverRevealClass, HOVER_REVEAL_PX, MIN_VISIBLE_PX } from '@/lib/ui/edge-dock'

describe('nearestDockEdge', () => {
  it('an untouched bubble (pos === null) always uses its own default corner', () => {
    expect(nearestDockEdge(null, 'left')).toBe('left')
    expect(nearestDockEdge(null, 'right')).toBe('right')
  })

  it('a dragged bubble on the left half of the screen docks left, regardless of its default corner', () => {
    expect(nearestDockEdge({ x: 0.1 }, 'right')).toBe('left')
  })

  it('a dragged bubble on the right half of the screen docks right, regardless of its default corner', () => {
    expect(nearestDockEdge({ x: 0.8 }, 'left')).toBe('right')
  })

  it('exactly the midpoint docks right (a defined, if arbitrary, tie-break — never throws)', () => {
    expect(nearestDockEdge({ x: 0.5 }, 'left')).toBe('right')
  })
})

describe('dockPositionStyle', () => {
  it('a left dock pushes the bubble fully past x=0 by (width - floor), regardless of any existing margin', () => {
    // The exact live bug this absolute version fixes: a relative transform computed
    // from a button's CURRENT position (which already has its own left-4/right-4
    // margin) left far more than the floor visible. An absolute left/right value has
    // no such dependency — this is the whole reason it's shaped this way.
    expect(dockPositionStyle('left', 56, 32)).toEqual({ left: '-24px', right: 'auto' })
  })

  it('a right dock pushes the bubble fully past the right edge by (width - floor)', () => {
    expect(dockPositionStyle('right', 56, 32)).toEqual({ left: 'auto', right: '-24px' })
  })

  it('always returns BOTH keys, one real value and one "auto" — never leaves the other axis active, ' +
     'which would stretch a fixed-position element that also has an explicit width', () => {
    const left = dockPositionStyle('left', 90, 32)!
    const right = dockPositionStyle('right', 90, 32)!
    expect(Object.keys(left).sort()).toEqual(['left', 'right'])
    expect(left.right).toBe('auto')
    expect(Object.keys(right).sort()).toEqual(['left', 'right'])
    expect(right.left).toBe('auto')
  })

  it('uses the exported floor by default', () => {
    expect(dockPositionStyle('left', 56)).toEqual({ left: `-${56 - MIN_VISIBLE_PX}px`, right: 'auto' })
  })

  it('never docks a bubble already narrower than (or equal to) the visible floor — nothing to hide', () => {
    expect(dockPositionStyle('left', 32, 32)).toBeUndefined()
    expect(dockPositionStyle('left', 20, 32)).toBeUndefined()
  })

  it('returns undefined when width has not been measured yet, rather than guessing', () => {
    expect(dockPositionStyle('left', null, 32)).toBeUndefined()
  })

  it('is unaffected by non-finite input — fails closed to "nothing to shift", never a NaN in a style value', () => {
    expect(dockPositionStyle('left', NaN, 32)).toBeUndefined()
    expect(dockPositionStyle('left', Infinity, 32)).toBeUndefined()
  })
})

describe('hover-reveal safety — the freeze/strobe incident this must never regress to', () => {
  // 2026-09-09: a first hover-reveal attempt reverted to each button's own
  // "natural" inset resting spot on hover. Live on a real phone, touching the
  // docked sliver froze/strobed the screen — the reveal moved the button's own
  // near edge PAST wherever the finger already was, dropping the hover the
  // instant it triggered, re-docking, landing the sliver back under the
  // finger, re-triggering the reveal. A loop. See lib/ui/edge-dock.ts's own
  // HOVER_REVEAL_PX header for the full incident and the geometric argument
  // for why revealing flush at the true edge (0) instead of the natural inset
  // spot cannot reopen it. These tests pin that argument as an executable
  // check, not just a comment someone has to trust.

  it('HOVER_REVEAL_PX is pinned at exactly 0 — the one value the containment proof depends on', () => {
    // Deliberately not "less than some threshold" — the proof requires EXACTLY
    // flush-with-the-edge (or further out), never a positive inset, however
    // small. Changing this number requires re-reading and re-deriving the
    // proof in the source comment, not just adjusting a threshold here.
    expect(HOVER_REVEAL_PX).toBe(0)
  })

  it('the docked-visible range is ALWAYS fully contained within the revealed range, for every ' +
     'realistic bubble width — this is the actual property that prevents the loop, not a specific number', () => {
    // A pointer resting ANYWHERE in the docked sliver [0, minVisible] must still be within the
    // revealed bubble's own span [HOVER_REVEAL_PX, HOVER_REVEAL_PX + width] once revealed, for
    // every width these three real buttons could plausibly have (the mobile pill's label-driven
    // width included) — otherwise revealing can sweep the bubble's edge past the pointer.
    const minVisible = MIN_VISIBLE_PX
    const realisticWidths = [20, 32, 44, 56, 61.8125, 90, 120, 200]
    for (const width of realisticWidths) {
      const dockedRangeEnd = minVisible // docked range is always [0, minVisible]
      const revealedRangeStart = HOVER_REVEAL_PX
      const revealedRangeEnd = HOVER_REVEAL_PX + width
      expect(revealedRangeStart).toBeLessThanOrEqual(0)
      expect(revealedRangeEnd).toBeGreaterThanOrEqual(dockedRangeEnd)
    }
  })

  it('produces a static, literal Tailwind class per edge — never a class built from a runtime ' +
     'value, which Tailwind\'s build-time scanner cannot see and would silently never generate CSS for', () => {
    expect(hoverRevealClass('left')).toBe('hover:!left-0')
    expect(hoverRevealClass('right')).toBe('hover:!right-0')
    // Both literally contain "left-0" / "right-0" as plain text, matching Tailwind's own
    // real utility names exactly — not an interpolated ${...} that would never match anything.
    expect(hoverRevealClass('left')).not.toMatch(/[${}]/)
    expect(hoverRevealClass('right')).not.toMatch(/[${}]/)
  })
})
