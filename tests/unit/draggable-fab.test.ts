/**
 * Draggable floating buttons — geometry and the tap-vs-drag rule.
 *
 * The tap threshold is the load-bearing one: without it a finger that wobbles
 * while tapping moves the button instead of opening the chat, which is exactly
 * why "mobile has no dragging" was the previous decision.
 */
import { describe, it, expect } from 'vitest'
import {
  isDragGesture,
  clampFabPos,
  readStoredFabPos,
  serializeFabPos,
  FAB_DRAG_THRESHOLD_PX,
  FAB_KEYS,
} from '@/lib/ui/draggable-fab'

const PHONE = { vw: 390, vh: 840, w: 56, h: 56 }
const DESKTOP = { vw: 1440, vh: 900, w: 56, h: 56 }

describe('isDragGesture — a tap must never become a drag', () => {
  it('a still finger is a tap', () => {
    expect(isDragGesture(0, 0)).toBe(false)
  })

  it('a small wobble while tapping is still a tap', () => {
    // The whole reason the threshold exists.
    expect(isDragGesture(2, 2)).toBe(false)
    expect(isDragGesture(0, 5)).toBe(false)
  })

  it('a deliberate move is a drag', () => {
    expect(isDragGesture(40, 0)).toBe(true)
    expect(isDragGesture(0, -60)).toBe(true)
  })

  it('measures real distance, not per-axis', () => {
    // 6,6 is ~8.49px away — a drag — even though neither axis alone reaches 8.
    expect(isDragGesture(6, 6)).toBe(true)
    expect(isDragGesture(5, 5)).toBe(false) // ~7.07
  })

  it('sits below a touch target so it cannot swallow a press', () => {
    expect(FAB_DRAG_THRESHOLD_PX).toBeLessThan(44)
  })

  it('tolerates garbage rather than throwing mid-gesture', () => {
    expect(isDragGesture(NaN, 0)).toBe(false)
    expect(isDragGesture(0, Infinity)).toBe(false)
  })
})

describe('clampFabPos — the button always stays fully on screen', () => {
  it('leaves a valid position alone', () => {
    expect(clampFabPos({ x: 0.5, y: 0.5 }, PHONE)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('keeps the whole button visible when dragged off the right edge', () => {
    const pos = clampFabPos({ x: 1, y: 0.5 }, PHONE)
    expect(pos.x * PHONE.vw + PHONE.w).toBeLessThanOrEqual(PHONE.vw)
  })

  it('keeps it visible when dragged off the bottom', () => {
    const pos = clampFabPos({ x: 0.5, y: 1 }, PHONE)
    expect(pos.y * PHONE.vh + PHONE.h).toBeLessThanOrEqual(PHONE.vh)
  })

  it('never goes negative', () => {
    expect(clampFabPos({ x: -1, y: -1 }, PHONE)).toEqual({ x: 0, y: 0 })
  })

  it('a spot picked on a 27-inch screen is still on screen on a phone', () => {
    // The reason positions are fractions rather than pixels.
    const onDesktop = clampFabPos({ x: 0.95, y: 0.9 }, DESKTOP)
    const sameSpotOnPhone = clampFabPos(onDesktop, PHONE)
    expect(sameSpotOnPhone.x * PHONE.vw + PHONE.w).toBeLessThanOrEqual(PHONE.vw)
    expect(sameSpotOnPhone.y * PHONE.vh + PHONE.h).toBeLessThanOrEqual(PHONE.vh)
  })

  it('pins to the corner if the button is bigger than the viewport', () => {
    expect(clampFabPos({ x: 0.5, y: 0.5 }, { vw: 40, vh: 40, w: 56, h: 56 })).toEqual({ x: 0, y: 0 })
  })

  it('survives an unmeasured element instead of guessing', () => {
    expect(clampFabPos({ x: 0.4, y: 0.4 })).toEqual({ x: 0.4, y: 0.4 })
    expect(clampFabPos({ x: 9, y: 9 })).toEqual({ x: 1, y: 1 })
  })
})

describe('readStoredFabPos — null means "never moved", not "broken"', () => {
  it('returns null when nothing is stored, so the CSS default corner applies', () => {
    expect(readStoredFabPos(null)).toBeNull()
    expect(readStoredFabPos('')).toBeNull()
  })

  it('returns null for garbage rather than throwing', () => {
    expect(readStoredFabPos('not json')).toBeNull()
    expect(readStoredFabPos('{"x":"left"}')).toBeNull()
    expect(readStoredFabPos('[1,2]')).toBeNull()
    expect(readStoredFabPos('{"x":1}')).toBeNull()
  })

  it('round-trips a real position', () => {
    const pos = { x: 0.25, y: 0.75 }
    expect(readStoredFabPos(serializeFabPos(pos))).toEqual(pos)
  })
})

describe('storage keys', () => {
  it('each button owns its own key so they cannot fight', () => {
    expect(FAB_KEYS.chat).not.toBe(FAB_KEYS.notes)
  })

  it('neither collides with the notes layer key that gets pruned every minute', () => {
    // The sticky-notes layer deletes any entry in its own map that is not a live
    // note id — a position parked there would vanish within ~60s.
    expect(Object.values(FAB_KEYS)).not.toContain('td-sticky-note-pos-v1')
  })
})
