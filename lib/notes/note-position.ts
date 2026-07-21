/**
 * Per-DEVICE floating-note positions. Stored in localStorage as viewport FRACTIONS (0..1),
 * never pixels — a spot set on a 27" iMac would be off-screen on a 380px phone. All reads and
 * writes are wrapped so a throwing/absent localStorage (Safari private mode, quota) can never
 * crash the floating layer. One key holds a { noteId: {x,y} } map, pruned to live notes on load.
 */

const KEY = "td-sticky-note-pos-v1"

export interface FracPos {
  x: number // 0..1 fraction of viewport width  (top-left of the card)
  y: number // 0..1 fraction of viewport height
}

type PosMap = Record<string, FracPos>

/** Clamp a fraction into [0, max] so a card can never be dragged fully off-screen. */
export function clampFrac(v: number, max = 0.92): number {
  if (typeof v !== "number" || isNaN(v)) return 0
  if (v < 0) return 0
  if (v > max) return max
  return v
}

export function readPositions(): PosMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as PosMap
  } catch {
    return {}
  }
}

/** Persist one note's position (clamped). Never throws. */
export function writePosition(noteId: string, pos: FracPos): void {
  try {
    const map = readPositions()
    map[noteId] = { x: clampFrac(pos.x), y: clampFrac(pos.y) }
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable — position simply isn't remembered on this device */
  }
}

/** Drop stored positions for notes that no longer exist (archived/deleted). Never throws. */
export function prunePositions(liveNoteIds: string[]): void {
  try {
    const map = readPositions()
    const live = new Set(liveNoteIds)
    let changed = false
    for (const id of Object.keys(map)) {
      if (!live.has(id)) {
        delete map[id]
        changed = true
      }
    }
    if (changed) localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* no-op */
  }
}

/**
 * Position for a note that has no stored spot yet: a deterministic cascade so a second device
 * doesn't stack every note on the same pixel. Wraps and stays clamped on-screen.
 */
export function cascadePos(index: number): FracPos {
  const step = 0.04
  const perColumn = 8
  const col = Math.floor(index / perColumn)
  const row = index % perColumn
  return { x: clampFrac(0.04 + col * 0.18), y: clampFrac(0.08 + row * step) }
}
