/**
 * Floating windows — the messages between a window and the main page, and what is remembered
 * (dev job f3f3e237, step 5).
 */

import { describe, it, expect } from "vitest"
import {
  WIN_MSG, parseFrameMessage, parseParentMessage, hasUnsentTyping,
} from "@/lib/windows/window-messages"
import {
  loadWindows, saveWindows, pruneOtherUsers, clearAllWindows, type KeyValueStore,
} from "@/lib/windows/windows-storage"
import { EMPTY_STATE, openWindow, storageKeyFor, type Viewport } from "@/lib/windows/window-model"

const vp: Viewport = { vw: 1600, vh: 900, topInset: 0 }

function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v) },
    removeItem: k => { data.delete(k) },
    get length() { return data.size },
    key: i => Array.from(data.keys())[i] ?? null,
  }
}

describe("parseFrameMessage", () => {
  it("accepts the five messages a window sends", () => {
    expect(parseFrameMessage({ t: WIN_MSG, k: "loc", url: "/leads?x=1", title: "Leads" })).toEqual({ t: WIN_MSG, k: "loc", url: "/leads?x=1", title: "Leads" })
    expect(parseFrameMessage({ t: WIN_MSG, k: "focus" })).toEqual({ t: WIN_MSG, k: "focus" })
    expect(parseFrameMessage({ t: WIN_MSG, k: "back" })).toEqual({ t: WIN_MSG, k: "back" })
    expect(parseFrameMessage({ t: WIN_MSG, k: "key", key: "k" })).toEqual({ t: WIN_MSG, k: "key", key: "k" })
    expect(parseFrameMessage({ t: WIN_MSG, k: "dirty-answer", req: "r1", dirty: true })).toEqual({ t: WIN_MSG, k: "dirty-answer", req: "r1", dirty: true })
  })
  it("rejects everything else, including other sites' addresses and other keys", () => {
    for (const bad of [null, undefined, 1, "x", [], {}, { t: "other", k: "focus" }, { t: WIN_MSG, k: "nope" },
      { t: WIN_MSG, k: "loc", url: "https://evil.example", title: "x" },
      { t: WIN_MSG, k: "loc", url: "//evil.example", title: "x" },
      { t: WIN_MSG, k: "loc", url: "/ok", title: 5 },
      { t: WIN_MSG, k: "key", key: "j" },
      { t: WIN_MSG, k: "dirty-answer", req: "r", dirty: "yes" }]) {
      expect(parseFrameMessage(bad), JSON.stringify(bad)).toBeNull()
    }
  })
  it("caps the length of what it accepts", () => {
    const m = parseFrameMessage({ t: WIN_MSG, k: "loc", url: "/" + "a".repeat(5000), title: "t".repeat(5000) })
    expect(m && m.k === "loc" && m.url.length <= 2000 && m.title.length <= 200).toBe(true)
  })
})

describe("parseParentMessage", () => {
  it("accepts go (same-site path) and ask-dirty", () => {
    expect(parseParentMessage({ t: WIN_MSG, k: "go", url: "/inbox" })).toEqual({ t: WIN_MSG, k: "go", url: "/inbox" })
    expect(parseParentMessage({ t: WIN_MSG, k: "ask-dirty", req: "r" })).toEqual({ t: WIN_MSG, k: "ask-dirty", req: "r" })
  })
  it("rejects anything that could send a window to another site", () => {
    for (const bad of [{ t: WIN_MSG, k: "go", url: "https://evil.example" }, { t: WIN_MSG, k: "go", url: "//evil.example" }, { t: WIN_MSG, k: "go" }, { k: "go", url: "/x" }, null]) {
      expect(parseParentMessage(bad)).toBeNull()
    }
  })
})

describe("hasUnsentTyping", () => {
  it("is true only for a connected field that still holds text", () => {
    expect(hasUnsentTyping([{ connected: true, text: "hello" }])).toBe(true)
    expect(hasUnsentTyping([{ connected: true, text: "   " }])).toBe(false) // typed then emptied: it was sent
    expect(hasUnsentTyping([{ connected: false, text: "hello" }])).toBe(false)
    expect(hasUnsentTyping([])).toBe(false)
  })
})

describe("windows storage", () => {
  const opened = () => {
    const r = openWindow(EMPTY_STATE, "/inbox", "Inbox", vp)
    if (!r.ok) throw new Error("open failed")
    return r.state
  }

  it("saves and loads per person", () => {
    const store = fakeStore()
    saveWindows(store, "antonio", opened())
    expect(loadWindows(store, "antonio", vp).windows.map(w => w.url)).toEqual(["/inbox"])
    expect(loadWindows(store, "luca", vp)).toEqual(EMPTY_STATE) // another person never sees them
  })
  it("forgets the entry when the last window closes", () => {
    const store = fakeStore()
    saveWindows(store, "antonio", opened())
    saveWindows(store, "antonio", EMPTY_STATE)
    expect(store.data.size).toBe(0)
  })
  it("prunes everybody else's windows but keeps mine, and touches no other key", () => {
    const store = fakeStore({ [storageKeyFor("antonio")]: "{}", [storageKeyFor("luca")]: "{}", "td-sidebar-order-v3": "x" })
    pruneOtherUsers(store, "antonio")
    expect(Array.from(store.data.keys()).sort()).toEqual(["td-sidebar-order-v3", storageKeyFor("antonio")].sort())
  })
  it("clears every remembered window set at sign-out, and nothing else", () => {
    const store = fakeStore({ [storageKeyFor("antonio")]: "{}", [storageKeyFor("luca")]: "{}", "td-sidebar-order-v3": "x" })
    clearAllWindows(store)
    expect(Array.from(store.data.keys())).toEqual(["td-sidebar-order-v3"])
  })
  it("never throws when storage is unavailable or broken", () => {
    const broken: KeyValueStore = {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: () => { throw new Error("blocked") },
      get length(): number { throw new Error("blocked") },
      key: () => { throw new Error("blocked") },
    }
    expect(loadWindows(broken, "a", vp)).toEqual(EMPTY_STATE)
    expect(() => saveWindows(broken, "a", opened())).not.toThrow()
    expect(() => pruneOtherUsers(broken, "a")).not.toThrow()
    expect(() => clearAllWindows(broken)).not.toThrow()
    expect(loadWindows(null, "a", vp)).toEqual(EMPTY_STATE)
    expect(() => saveWindows(null, "a", opened())).not.toThrow()
  })
})
