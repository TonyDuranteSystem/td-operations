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
