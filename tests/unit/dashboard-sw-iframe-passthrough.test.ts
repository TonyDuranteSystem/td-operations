/**
 * The dashboard service worker must NOT re-request page loads that happen inside a frame
 * (dev job f3f3e237, found by browser QA 2026-10-05).
 *
 * Why this matters: fetch(event.request) from a service worker makes the browser drop the
 * `Sec-Fetch-Dest: iframe` label of a navigation (it becomes "empty"). The dashboard layout
 * reads that label to decide window mode, so while the worker was active every framed page
 * came back as the full CRM — the whole floating-window idea silently failed in everyday use.
 * Letting the browser handle framed navigations itself keeps the label intact.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const sw = readFileSync(join(__dirname, "..", "..", "public", "dashboard-sw.js"), "utf8")

describe("dashboard-sw.js fetch handler", () => {
  const start = sw.indexOf("self.addEventListener('fetch'")
  const end = sw.indexOf("// Push notifications")
  const handler = sw.slice(start, end)

  it("has a fetch handler to inspect", () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it("lets framed page loads bypass the worker, before it takes over the request", () => {
    const bypass = handler.indexOf("event.request.destination === 'iframe'")
    const takeover = handler.indexOf("event.respondWith(")
    expect(bypass).toBeGreaterThan(-1)
    expect(takeover).toBeGreaterThan(bypass)
    expect(handler).toMatch(/destination === 'iframe'\) return/)
  })

  it("still handles normal page loads (offline fallback) and nothing but page loads", () => {
    expect(handler).toMatch(/if \(event\.request\.mode !== 'navigate'\) return/)
    expect(handler).toContain("caches.match(OFFLINE_URL)")
  })
})

describe("dashboard-sw.js notification click (dev job f3f3e237)", () => {
  const click = sw.slice(sw.indexOf("self.addEventListener('notificationclick'"))

  it("prefers the top-level page, never a floating window's frame", () => {
    expect(click).toContain("c.frameType === 'top-level'")
  })

  it("asks the page to navigate itself, and only falls back to a full reload if it never answers", () => {
    expect(click).toContain("client.postMessage({ type: 'td-navigate', url: url }, [channel.port2])")
    expect(click).toContain("setTimeout(fallback, 700)")
    expect(click).toContain("client.navigate(url)")
    // the full navigation lives only inside the fallback
    expect(click.indexOf("client.navigate(url)")).toBeGreaterThan(click.indexOf("function fallback()"))
    expect(click.indexOf("client.navigate(url)")).toBeLessThan(click.indexOf("var timer"))
  })

  it("still opens a new window when no page is open", () => {
    expect(click).toContain("if (!client) return clients.openWindow(url)")
  })

  it("the page side answers on the port and only follows a normal same-site CRM path", () => {
    const reg = readFileSync(join(__dirname, "..", "..", "components", "dashboard", "sw-register.tsx"), "utf8")
    expect(reg).toContain("e.ports[0]?.postMessage('ok')")
    expect(reg).toContain("u.origin !== window.location.origin")
    expect(reg).toContain("isInternalNavHref(path)")
  })
})
