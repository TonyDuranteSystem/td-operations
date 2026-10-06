/**
 * Floating windows — the rules (dev job f3f3e237, step 5).
 */

import { describe, it, expect } from "vitest"
import { readdirSync } from "fs"
import { join } from "path"
import {
  MAX_WINDOWS, WINDOW_PAGE_ROOTS, WINDOW_MIN_W, WINDOW_MIN_H, EMPTY_STATE,
  isWindowableUrl, isSignedOutPath, sameWindowPage, fallbackTitle,
  clampBox, resizeBox, nextOpenBox,
  openWindow, closeWindow, focusWindow, minimizeWindow, restoreWindow, setBox, setLocation, clampAll, frontWindowId,
  storageKeyFor, isWindowsStorageKey, serializeState, parseState,
  type Viewport, type WindowsState,
} from "@/lib/windows/window-model"

const vp: Viewport = { vw: 1600, vh: 900, topInset: 0 }
const vpBanner: Viewport = { vw: 1600, vh: 900, topInset: 40 }

function open(state: WindowsState, url: string) {
  const r = openWindow(state, url, undefined, vp)
  if (!r.ok) throw new Error("expected ok: " + r.reason)
  return r
}

describe("isWindowableUrl", () => {
  it("accepts ordinary CRM pages, with queries", () => {
    expect(isWindowableUrl("/inbox")).toBe(true)
    expect(isWindowableUrl("/accounts/123?tab=docs")).toBe(true)
    expect(isWindowableUrl("/portal-chats?account=1")).toBe(true) // "/portal-chats" is NOT "/portal"
  })
  it("refuses other sites and sneaky forms", () => {
    expect(isWindowableUrl("https://evil.example/inbox")).toBe(false)
    expect(isWindowableUrl("//evil.example")).toBe(false)
    expect(isWindowableUrl("/\\evil.example")).toBe(false)
    expect(isWindowableUrl("inbox")).toBe(false)
    expect(isWindowableUrl("javascript:alert(1)")).toBe(false)
    expect(isWindowableUrl("")).toBe(false)
    expect(isWindowableUrl(null)).toBe(false)
    expect(isWindowableUrl(42)).toBe(false)
  })
  it("accepts the home page and only the home page at the root", () => {
    expect(isWindowableUrl("/")).toBe(true)
    expect(isWindowableUrl("/?tab=x")).toBe(true)
  })
  it("refuses sign-in, API, the client portal, public client pages and unknown pages — any case, any query", () => {
    for (const u of ["/login", "/login?next=/inbox", "/mfa/verify", "/api/accounts", "/portal", "/portal/chat", "/Portal/x", "/offer/abc", "/lease/abc", "/pay/abc", "/sign/abc", "/_next/static/x", "/auth/callback", "/oauth/x", "/nope", "/inboxx", "/%2e%2e/inbox"]) {
      expect(isWindowableUrl(u), u).toBe(false)
    }
  })
  it("accepts the oddball nested dashboard page", () => {
    expect(isWindowableUrl("/dashboard/td-communication")).toBe(true)
  })
  it("is case-sensitive on the page root, like the routes (an upper-case page is a 404, not a window)", () => {
    expect(isWindowableUrl("/Inbox")).toBe(false)
    expect(isWindowableUrl("/TASKS")).toBe(false)
    expect(isWindowableUrl("/tasKs")).toBe(false) // Kelvin sign look-alike
  })
  it("refuses dot-segments that a browser would resolve to a forbidden page", () => {
    for (const u of ["/accounts/%2e%2e/portal/login", "/inbox/../api/x", "/inbox/./x", "/accounts/%2E%2E/login", "/inbox/..", "/a/%2e/b".replace("/a", "/leads")]) {
      expect(isWindowableUrl(u), u).toBe(false)
    }
    expect(isWindowableUrl("/accounts/some.name")).toBe(true) // a dot inside a name is fine
    expect(isWindowableUrl("/accounts/...x")).toBe(true)
  })
  it("every folder under app/(dashboard) is on the list (so a new CRM page can't silently be un-windowable)", () => {
    const dir = join(__dirname, "..", "..", "app", "(dashboard)")
    const folders = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    const missing = folders.filter(f => !WINDOW_PAGE_ROOTS.includes(f))
    expect(missing, "add these to WINDOW_PAGE_ROOTS (lib/windows/window-model.ts)").toEqual([])
    const stale = WINDOW_PAGE_ROOTS.filter(r => !folders.includes(r))
    expect(stale, "these roots no longer exist under app/(dashboard)").toEqual([])
  })
})

describe("isSignedOutPath / sameWindowPage / fallbackTitle", () => {
  it("recognises the sign-in pages only", () => {
    expect(isSignedOutPath("/login")).toBe(true)
    expect(isSignedOutPath("/mfa/verify")).toBe(true)
    expect(isSignedOutPath("/loginx")).toBe(false)
    expect(isSignedOutPath("/inbox")).toBe(false)
  })
  it("ignores a #hash but not the query", () => {
    expect(sameWindowPage("/leads#a", "/leads")).toBe(true)
    expect(sameWindowPage("/leads?x=1", "/leads")).toBe(false)
  })
  it("makes a readable fallback title", () => {
    expect(fallbackTitle("/portal-chats?x=1")).toBe("Portal chats")
    expect(fallbackTitle("/")).toBe("Home")
  })
})

describe("clampBox", () => {
  it("never goes below the floor or above the screen", () => {
    const b = clampBox({ x: 10, y: 10, w: 10, h: 10 }, vp)
    expect(b.w).toBe(WINDOW_MIN_W)
    expect(b.h).toBe(WINDOW_MIN_H)
    const big = clampBox({ x: 0, y: 0, w: 99999, h: 99999 }, vp)
    expect(big.w).toBeLessThanOrEqual(vp.vw)
    expect(big.h).toBeLessThanOrEqual(vp.vh)
  })
  it("keeps the title bar reachable: never above the banner, never fully off a side", () => {
    expect(clampBox({ x: 0, y: -500, w: 800, h: 500 }, vpBanner).y).toBe(40)
    const off = clampBox({ x: 99999, y: 0, w: 800, h: 500 }, vp)
    expect(off.x).toBeLessThan(vp.vw)
    const left = clampBox({ x: -99999, y: 0, w: 800, h: 500 }, vp)
    expect(left.x + 800).toBeGreaterThan(0)
  })
  it("repairs nonsense numbers", () => {
    const b = clampBox({ x: NaN, y: Infinity as number, w: undefined as unknown as number, h: "9" as unknown as number }, vp)
    for (const v of Object.values(b)) expect(Number.isFinite(v)).toBe(true)
  })
})

describe("resizeBox", () => {
  const start = { x: 200, y: 100, w: 800, h: 600 }
  it("east/south grow from the corner", () => {
    expect(resizeBox(start, "se", 50, 40, vp)).toEqual({ x: 200, y: 100, w: 850, h: 640 })
  })
  it("west keeps the right edge fixed", () => {
    const b = resizeBox(start, "w", -100, 0, vp)
    expect(b.x + b.w).toBe(1000)
    expect(b.w).toBe(900)
  })
  it("respects the minimum size without the window sliding", () => {
    const b = resizeBox(start, "w", 5000, 0, vp)
    expect(b.w).toBe(WINDOW_MIN_W)
    expect(b.x + b.w).toBe(1000)
    const t = resizeBox(start, "n", 0, 5000, vp)
    expect(t.h).toBe(WINDOW_MIN_H)
    expect(t.y + t.h).toBe(700)
  })
  it("the top edge cannot be dragged above the banner", () => {
    const b = resizeBox({ x: 200, y: 60, w: 800, h: 600 }, "n", 0, -500, vpBanner)
    expect(b.y).toBe(40)
    expect(b.y + b.h).toBe(660)
  })
})

describe("openWindow", () => {
  it("opens, titles and stacks", () => {
    const r = open(EMPTY_STATE, "/inbox")
    expect(r.state.windows).toHaveLength(1)
    expect(r.state.windows[0]).toMatchObject({ url: "/inbox", title: "Inbox", minimized: false })
  })
  it("refuses a bad address", () => {
    const r = openWindow(EMPTY_STATE, "https://x.example", undefined, vp)
    expect(r).toMatchObject({ ok: false, reason: "bad_url" })
  })
  it("the same page is brought to the front and un-minimised, not duplicated", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads").state
    s = minimizeWindow(s, s.windows[0].id)
    const r = open(s, "/inbox#x")
    expect(r.reused).toBe(true)
    expect(r.state.windows).toHaveLength(2)
    const w = r.state.windows.find(x => x.url === "/inbox")!
    expect(w.minimized).toBe(false)
    expect(frontWindowId(r.state)).toBe(w.id)
  })
  it("refuses a fourth window", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads").state
    s = open(s, "/tasks").state
    expect(s.windows).toHaveLength(MAX_WINDOWS)
    const r = openWindow(s, "/accounts", undefined, vp)
    expect(r).toMatchObject({ ok: false, reason: "cap" })
  })
  it("gives every window a unique id, even after one is closed", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads").state
    s = closeWindow(s, s.windows[0].id)
    s = open(s, "/tasks").state
    s = open(s, "/accounts").state
    const ids = s.windows.map(w => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it("staggers new windows so they do not sit exactly on top of each other", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads").state
    expect(s.windows[0].x === s.windows[1].x && s.windows[0].y === s.windows[1].y).toBe(false)
    const b = nextOpenBox(s.windows, vpBanner)
    expect(b.y).toBeGreaterThanOrEqual(40)
  })
})

describe("changing windows", () => {
  it("focus brings a window in front; focusing the front one changes nothing", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads").state
    const [a, b] = s.windows
    expect(frontWindowId(s)).toBe(b.id)
    const f = focusWindow(s, a.id)
    expect(frontWindowId(f)).toBe(a.id)
    expect(focusWindow(f, a.id)).toBe(f)
  })
  it("minimised windows are never 'in front'", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads").state
    s = minimizeWindow(s, s.windows[1].id)
    expect(frontWindowId(s)).toBe(s.windows[0].id)
    s = minimizeWindow(s, s.windows[0].id)
    expect(frontWindowId(s)).toBeNull()
    expect(frontWindowId(restoreWindow(s, s.windows[0].id))).toBe(s.windows[0].id)
  })
  it("close removes; unknown ids change nothing", () => {
    const s = open(EMPTY_STATE, "/inbox").state
    expect(closeWindow(s, "nope")).toBe(s)
    expect(closeWindow(s, s.windows[0].id).windows).toHaveLength(0)
    expect(focusWindow(s, "nope")).toBe(s)
    expect(minimizeWindow(s, "nope")).toBe(s)
    expect(setBox(s, "nope", { x: 0, y: 0, w: 500, h: 400 })).toBe(s)
  })
  it("setLocation follows the frame, and refuses an address a window may not show", () => {
    const s = open(EMPTY_STATE, "/inbox").state
    const id = s.windows[0].id
    const moved = setLocation(s, id, "/leads?x=1", "Leads")
    expect(moved.windows[0]).toMatchObject({ url: "/leads?x=1", title: "Leads" })
    expect(setLocation(moved, id, "/login", "Sign in")).toBe(moved)
    expect(setLocation(moved, id, "/leads?x=1", "Leads")).toBe(moved) // no change → same object
  })
  it("a generic page title falls back to the page name", () => {
    const s = open(EMPTY_STATE, "/inbox").state
    const moved = setLocation(s, s.windows[0].id, "/leads/abc", "TD Operations")
    expect(moved.windows[0].title).toBe("Leads")
    expect(setLocation(moved, s.windows[0].id, "/leads/abc", "Lead — TD Operations").windows[0].title).toBe("Lead — TD Operations")
  })
  it("a name chosen by whoever opened the window survives the page's generic title, within the same section", () => {
    const r = openWindow(EMPTY_STATE, "/accounts/abc", "Acme Holdings LLC", vp)
    if (!r.ok) throw new Error("open failed")
    const id = r.state.windows[0].id
    expect(setLocation(r.state, id, "/accounts/abc", "TD Operations").windows[0].title).toBe("Acme Holdings LLC")
    expect(setLocation(r.state, id, "/accounts/abc?tab=docs", "TD Operations").windows[0].title).toBe("Acme Holdings LLC")
    expect(setLocation(r.state, id, "/leads", "TD Operations").windows[0].title).toBe("Leads") // moved elsewhere
    expect(setLocation(r.state, id, "/accounts/abc", "Real page title").windows[0].title).toBe("Real page title")
  })
  it("clampAll pulls windows back after the screen shrinks, and is a no-op when nothing moved", () => {
    const s = setBox(open(EMPTY_STATE, "/inbox").state, "w1", { x: 1500, y: 800, w: 1000, h: 600 })
    const small: Viewport = { vw: 1100, vh: 700, topInset: 0 }
    const c = clampAll(s, small)
    expect(c.windows[0].x).toBeLessThan(small.vw)
    expect(c.windows[0].y).toBeLessThan(small.vh)
    expect(clampAll(c, small)).toBe(c)
  })
})

describe("remembering", () => {
  it("uses one key per person", () => {
    expect(storageKeyFor("u1")).not.toBe(storageKeyFor("u2"))
    expect(isWindowsStorageKey(storageKeyFor("u1"))).toBe(true)
    expect(isWindowsStorageKey("other")).toBe(false)
  })
  it("round-trips", () => {
    let s = open(EMPTY_STATE, "/inbox").state
    s = open(s, "/leads?x=1").state
    s = minimizeWindow(s, s.windows[0].id)
    const back = parseState(serializeState(s), vp)
    expect(back.windows.map(w => w.url)).toEqual(["/inbox", "/leads?x=1"])
    expect(back.windows[0].minimized).toBe(true)
    expect(back.windows[1].minimized).toBe(false)
  })
  it("re-checks every stored address against today's rules and drops the bad ones", () => {
    const raw = JSON.stringify({ v: 1, windows: [
      { url: "https://evil.example", x: 0, y: 0, w: 800, h: 500 },
      { url: "/login", x: 0, y: 0, w: 800, h: 500 },
      { url: "/api/x", x: 0, y: 0, w: 800, h: 500 },
      { url: "/inbox", x: 0, y: 0, w: 800, h: 500 },
    ] })
    expect(parseState(raw, vp).windows.map(w => w.url)).toEqual(["/inbox"])
  })
  it("caps at three, drops duplicates, and survives garbage", () => {
    const many = JSON.stringify({ windows: ["/inbox", "/leads", "/leads", "/tasks", "/accounts"].map(url => ({ url, x: 0, y: 0, w: 800, h: 500 })) })
    expect(parseState(many, vp).windows.map(w => w.url)).toEqual(["/inbox", "/leads", "/tasks"])
    for (const bad of [null, "", "{", "[]", "null", '{"windows":5}', '{"windows":[null,1,"x"]}']) {
      expect(parseState(bad, vp)).toEqual(EMPTY_STATE)
    }
  })
  it("repairs absurd stored sizes and positions", () => {
    const raw = JSON.stringify({ windows: [{ url: "/inbox", x: 1e9, y: -1e9, w: 1, h: 1e9 }] })
    const w = parseState(raw, vpBanner).windows[0]
    expect(w.w).toBeGreaterThanOrEqual(WINDOW_MIN_W)
    expect(w.y).toBeGreaterThanOrEqual(40)
    expect(w.x).toBeLessThan(vpBanner.vw)
  })
  it("hands out small unique ids and a usable stacking order", () => {
    const raw = JSON.stringify({ windows: [{ url: "/inbox", z: 90 }, { url: "/leads", z: 5 }] })
    const s = parseState(raw, vp)
    expect(new Set(s.windows.map(w => w.id)).size).toBe(2)
    expect(frontWindowId(s)).toBe(s.windows.find(w => w.url === "/inbox")!.id)
    expect(open(s, "/tasks").state.windows).toHaveLength(3)
  })
})
