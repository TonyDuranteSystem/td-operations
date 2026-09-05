/**
 * Sticky-note cascade positioning. The bug class this guards against: the active-notes feed
 * sorts newest-first, so a brand-new note is always index 0. A version keyed on array index
 * alone gave every never-moved note the identical slot the instant a second one appeared,
 * because a note already on screen keeps whatever position it got at its OWN first mount and
 * never recomputes just because a sibling was added (Antonio, 2026-09-05: "they go one on top
 * of the other and I can't see them unless i move them"). cascadePos is called once per note,
 * in one pass over the whole list, each call told what every earlier note in that pass landed
 * on — so it must actively skip occupied slots, not just derive a slot from a number.
 */
import { describe, it, expect } from "vitest"
import { clampFrac, cascadePos, type FracPos } from "@/lib/notes/note-position"

describe("clampFrac", () => {
  it("passes through an in-range value", () => {
    expect(clampFrac(0.5)).toBe(0.5)
  })
  it("floors negative values at 0", () => {
    expect(clampFrac(-0.3)).toBe(0)
  })
  it("caps above the default max (0.92)", () => {
    expect(clampFrac(1.5)).toBe(0.92)
  })
  it("respects a custom max", () => {
    expect(clampFrac(0.8, 0.5)).toBe(0.5)
  })
  it("treats NaN / non-numbers as 0", () => {
    expect(clampFrac(NaN)).toBe(0)
    expect(clampFrac("nope" as unknown as number)).toBe(0)
  })
})

describe("cascadePos — first slot", () => {
  it("returns the first cascade slot when nothing is occupied yet", () => {
    expect(cascadePos([])).toEqual({ x: 0.04, y: 0.08 })
  })
})

describe("cascadePos — the actual bug: never repeats an occupied slot", () => {
  it("does not return a slot already taken by one other note", () => {
    const first = cascadePos([])
    const second = cascadePos([first])
    expect(second).not.toEqual(first)
  })

  it("assigns three sequential notes three distinct slots (three notes created one after another, none ever dragged)", () => {
    const occupied: FracPos[] = []
    const positions: FracPos[] = []
    for (let i = 0; i < 3; i++) {
      const pos = cascadePos(occupied)
      positions.push(pos)
      occupied.push(pos)
    }
    const unique = new Set(positions.map((p) => `${p.x},${p.y}`))
    expect(unique.size).toBe(3)
  })

  it("fills a column top-to-bottom before starting a new column", () => {
    const occupied: FracPos[] = []
    const positions: FracPos[] = []
    for (let i = 0; i < 9; i++) {
      const pos = cascadePos(occupied)
      positions.push(pos)
      occupied.push(pos)
    }
    // perColumn is 8 — the 9th slot (index 8) must start a second column, not
    // reuse the first column's y sequence at a colliding x.
    expect(positions[8].x).not.toBe(positions[0].x)
    expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBe(9)
  })

  it("finds a free slot even when earlier slots are occupied out of order", () => {
    // Simulates: note A got the 3rd cascade slot (dragged there long ago and stored),
    // note B and note C have never been moved — B and C must not collide with A or
    // with each other.
    const thirdSlot = (() => {
      let last: FracPos = { x: 0, y: 0 }
      const occ: FracPos[] = []
      for (let i = 0; i < 3; i++) { last = cascadePos(occ); occ.push(last) }
      return last
    })()
    const occupied = [thirdSlot]
    const b = cascadePos(occupied)
    occupied.push(b)
    const c = cascadePos(occupied)
    expect(b).not.toEqual(thirdSlot)
    expect(c).not.toEqual(thirdSlot)
    expect(c).not.toEqual(b)
  })

  it("stays clamped on-screen even after many slots", () => {
    const occupied: FracPos[] = []
    for (let i = 0; i < 40; i++) {
      const pos = cascadePos(occupied)
      expect(pos.x).toBeGreaterThanOrEqual(0)
      expect(pos.x).toBeLessThanOrEqual(0.92)
      expect(pos.y).toBeGreaterThanOrEqual(0)
      expect(pos.y).toBeLessThanOrEqual(0.92)
      occupied.push(pos)
    }
  })
})
