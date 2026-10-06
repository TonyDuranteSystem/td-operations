/**
 * Guided-tour plumbing (dev job f3f3e237): the "one tour at a time" lock, the window events a tour waits
 * for, and the windows snapshot store.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { acquireTour, releaseTour, activeTour, isAnyTourActive, __resetTourLock } from "@/lib/ui/tour-lock"
import { classifyDrag, MIN_DRAG_PX } from "@/lib/windows/window-events"
import {
  EMPTY_SNAPSHOT, snapshotsEqual, setWindowsSnapshot, getWindowsSnapshot, subscribeWindows, type WindowsSnapshot,
} from "@/lib/windows/windows-store"

describe("tour lock", () => {
  beforeEach(() => __resetTourLock())

  it("lets one tour hold it and refuses a second", () => {
    expect(acquireTour("whatsapp")).toBe(true)
    expect(acquireTour("windows")).toBe(false)
    expect(activeTour()).toBe("whatsapp")
    expect(isAnyTourActive()).toBe(true)
  })

  it("the same tour can take it again, and only the holder can release it", () => {
    acquireTour("windows")
    expect(acquireTour("windows")).toBe(true)
    releaseTour("whatsapp") // not the holder: no effect
    expect(isAnyTourActive()).toBe(true)
    releaseTour("windows")
    expect(isAnyTourActive()).toBe(false)
    expect(acquireTour("whatsapp")).toBe(true)
  })
})

describe("classifyDrag", () => {
  const start = { x: 100, y: 100, w: 800, h: 600 }

  it("a bare click on the bar is not a move", () => {
    expect(classifyDrag(start, { ...start, x: 103, y: 102 }, "move")).toBeNull()
  })
  it("travelling the minimum distance counts as a move, in any direction", () => {
    expect(classifyDrag(start, { ...start, x: 100 + MIN_DRAG_PX, y: 100 }, "move")).toBe("moved")
    expect(classifyDrag(start, { ...start, x: 100, y: 100 - 30 }, "move")).toBe("moved")
  })
  it("a resize needs the size to really change", () => {
    expect(classifyDrag(start, { ...start, w: 805 }, "resize")).toBeNull()
    expect(classifyDrag(start, { ...start, w: 760, h: 590 }, "resize")).toBe("resized")
  })
  it("moving a window's top-left while resizing does not make it a 'move'", () => {
    // the caller passes mode 'resize' for edges, so a left-edge drag (x changes, w changes) is a resize
    expect(classifyDrag(start, { x: 60, y: 100, w: 840, h: 600 }, "resize")).toBe("resized")
  })
})

describe("windows snapshot store", () => {
  const snap = (over: Partial<WindowsSnapshot> = {}): WindowsSnapshot => ({ ...EMPTY_SNAPSHOT, ready: true, ...over })

  it("compares by value", () => {
    expect(snapshotsEqual(snap({ ids: ["w1"], count: 1 }), snap({ ids: ["w1"], count: 1 }))).toBe(true)
    expect(snapshotsEqual(snap({ ids: ["w1"], count: 1 }), snap({ ids: ["w2"], count: 1 }))).toBe(false)
    expect(snapshotsEqual(snap(), snap({ minimized: ["w1"] }))).toBe(false)
  })

  it("tells subscribers only when something really changed", () => {
    setWindowsSnapshot(EMPTY_SNAPSHOT)
    let calls = 0
    const off = subscribeWindows(() => { calls += 1 })
    setWindowsSnapshot(snap({ count: 1, ids: ["w1"], urls: ["/accounts"] }))
    setWindowsSnapshot(snap({ count: 1, ids: ["w1"], urls: ["/accounts"] })) // identical: silent
    expect(calls).toBe(1)
    expect(getWindowsSnapshot().urls).toEqual(["/accounts"])
    off()
    setWindowsSnapshot(snap({ count: 2, ids: ["w1", "w2"] }))
    expect(calls).toBe(1) // unsubscribed
    setWindowsSnapshot(EMPTY_SNAPSHOT)
  })
})
