import { describe, it, expect } from 'vitest'
import {
  checkEmailFrameStillValid,
  computeCompositeDraw,
  intersectRects,
  rectsIntersect,
  type EmailFrameSnapshot,
} from '@/lib/captures/email-frame-composite'

describe('rectsIntersect', () => {
  it('detects a real overlap', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })).toBe(true)
  })

  it('detects two rects that do not touch at all', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 })).toBe(false)
  })

  it('treats two rects that only touch at an edge as NOT overlapping', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false)
  })
})

describe('intersectRects', () => {
  it('returns the overlapping portion of two rects', () => {
    const overlap = intersectRects({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })
    expect(overlap).toEqual({ x: 50, y: 50, width: 50, height: 50 })
  })

  it('returns null for two rects that do not overlap', () => {
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 })).toBeNull()
  })

  it('returns the full smaller rect when one fully contains the other', () => {
    const overlap = intersectRects({ x: 20, y: 20, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })
    expect(overlap).toEqual({ x: 20, y: 20, width: 10, height: 10 })
  })
})

describe('checkEmailFrameStillValid', () => {
  const snapshot: EmailFrameSnapshot = { identity: 'msg-1', rect: { x: 10, y: 20, width: 300, height: 150 } }

  it('accepts a snapshot that still matches reality exactly', () => {
    const result = checkEmailFrameStillValid(snapshot, {
      attached: true,
      identity: 'msg-1',
      rect: { x: 10, y: 20, width: 300, height: 150 },
    })
    expect(result).toEqual({ valid: true })
  })

  it('rejects a removed iframe (collapsed, or its conversation left) rather than guessing', () => {
    const result = checkEmailFrameStillValid(snapshot, { attached: false, identity: null, rect: null })
    expect(result).toEqual({ valid: false, reason: 'removed' })
  })

  it('rejects when the same DOM node now belongs to a different email', () => {
    const result = checkEmailFrameStillValid(snapshot, {
      attached: true,
      identity: 'msg-2',
      rect: { x: 10, y: 20, width: 300, height: 150 },
    })
    expect(result).toEqual({ valid: false, reason: 'identity-changed' })
  })

  it('rejects a size change (a late-loading image growing the email taller) even with the same identity', () => {
    const result = checkEmailFrameStillValid(snapshot, {
      attached: true,
      identity: 'msg-1',
      rect: { x: 10, y: 20, width: 300, height: 400 },
    })
    expect(result).toEqual({ valid: false, reason: 'size-or-position-changed' })
  })

  it('rejects a position change (content above it grew/shrank) even with the same identity and size', () => {
    const result = checkEmailFrameStillValid(snapshot, {
      attached: true,
      identity: 'msg-1',
      rect: { x: 10, y: 90, width: 300, height: 150 },
    })
    expect(result).toEqual({ valid: false, reason: 'size-or-position-changed' })
  })
})

describe('computeCompositeDraw', () => {
  it('places a fully-selected iframe at the region-relative origin, scaled', () => {
    const draw = computeCompositeDraw(
      { x: 100, y: 200, width: 300, height: 150 },
      { x: 50, y: 150, width: 500, height: 400 },
      2,
    )
    // iframe origin (100,200) minus region origin (50,150) = (50,50), scaled by 2
    expect(draw).toEqual({
      src: { x: 0, y: 0, width: 600, height: 300 },
      dest: { x: 100, y: 100, width: 600, height: 300 },
    })
  })

  it('clips to the overlap when the selection only partially covers the iframe', () => {
    // Selection starts 50px into the iframe both horizontally and vertically.
    const draw = computeCompositeDraw(
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 50, y: 50, width: 300, height: 300 },
      1,
    )
    expect(draw).toEqual({
      // Source crop starts 50px into the iframe's OWN canvas (the part outside the selection is excluded).
      src: { x: 50, y: 50, width: 150, height: 150 },
      // Destination starts at the region's own origin (0,0) since the overlap begins exactly at the selection's corner.
      dest: { x: 0, y: 0, width: 150, height: 150 },
    })
  })

  it('returns null when the iframe and the region do not actually overlap', () => {
    const draw = computeCompositeDraw({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }, 1)
    expect(draw).toBeNull()
  })
})
