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

/** Two slots close enough to call "the same spot" — loose enough that floating-point
 *  noise never creates a phantom free slot, tight enough that real cascade slots
 *  (0.04 apart) never collide with each other. */
const SLOT_EPSILON = 0.01

function isSlotTaken(candidate: FracPos, occupied: readonly FracPos[]): boolean {
  return occupied.some((p) => Math.abs(p.x - candidate.x) < SLOT_EPSILON && Math.abs(p.y - candidate.y) < SLOT_EPSILON)
}

/**
 * Position for a note that has no stored spot yet: the first cascade slot NOT already
 * used by another currently-visible note. `occupied` must include every other note's
 * position already decided in this same pass (stored or freshly cascaded) — walking
 * the cascade until a free slot is found, rather than trusting the note's array index,
 * is what a fixed-index version got wrong (Antonio, 2026-09-05: notes were landing
 * exactly on top of each other). The feed sorts newest-first, so a brand-new note is
 * always index 0 — every note ever created with no stored position would compute the
 * identical index-0 slot, because a note already on screen keeps the position it got
 * at ITS OWN first mount and never recomputes just because a sibling was added.
 */
export function cascadePos(occupied: readonly FracPos[]): FracPos {
  const step = 0.04
  const perColumn = 8
  for (let i = 0; i < 500; i++) {
    const col = Math.floor(i / perColumn)
    const row = i % perColumn
    const candidate = { x: clampFrac(0.04 + col * 0.18), y: clampFrac(0.08 + row * step) }
    if (!isSlotTaken(candidate, occupied)) return candidate
  }
  // Exhausted 500 slots (500 simultaneous never-moved notes) — reuse the first
  // rather than loop forever; dragging is still available to separate them.
  return { x: clampFrac(0.04), y: clampFrac(0.08) }
}
