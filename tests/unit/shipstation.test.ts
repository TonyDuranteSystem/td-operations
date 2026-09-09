/**
 * lib/shipstation.ts — the ShipStation V2 label-lookup wrapper. Mocks global fetch;
 * never makes a real network call.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { lookupTrackingStatus } from "@/lib/shipstation"

const ORIGINAL_ENV = process.env.SHIPSTATION_V2_API_KEY

beforeEach(() => {
  process.env.SHIPSTATION_V2_API_KEY = "test-key"
})

afterEach(() => {
  process.env.SHIPSTATION_V2_API_KEY = ORIGINAL_ENV
  vi.unstubAllGlobals()
})

describe("lookupTrackingStatus", () => {
  it("throws if the API key env var is missing — never silently proceeds unauthenticated", async () => {
    delete process.env.SHIPSTATION_V2_API_KEY
    await expect(lookupTrackingStatus("1Z999")).rejects.toThrow(/SHIPSTATION_V2_API_KEY/)
  })

  it("sends the tracking number as a query param and the key as the api-key header", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("tracking_number=1Z999")
      expect((init.headers as Record<string, string>)["api-key"]).toBe("test-key")
      return new Response(JSON.stringify({ labels: [] }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await lookupTrackingStatus("1Z999")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("URL-encodes a tracking number with special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain(encodeURIComponent("1Z 999/ABC"))
      return new Response(JSON.stringify({ labels: [] }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await lookupTrackingStatus("1Z 999/ABC")
  })

  it("reports found:false on an empty labels array (no such label — not an error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ labels: [] }), { status: 200 })))
    const result = await lookupTrackingStatus("1Z999")
    expect(result).toEqual({ found: false })
  })

  it("reports the matched label's status and ship date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ labels: [{ tracking_status: "delivered", ship_date: "2026-08-01T00:00:00Z" }] }), { status: 200 })),
    )
    const result = await lookupTrackingStatus("1Z999")
    expect(result).toEqual({ found: true, status: "delivered", shipDate: "2026-08-01T00:00:00Z" })
  })

  it("defaults to 'unknown' if a matched label omits tracking_status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ labels: [{}] }), { status: 200 })))
    const result = await lookupTrackingStatus("1Z999")
    expect(result).toEqual({ found: true, status: "unknown", shipDate: null })
  })

  it("throws on a non-2xx response — the caller must treat this as 'skip, retry later', not as 'no match'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500, statusText: "Internal Server Error" })))
    await expect(lookupTrackingStatus("1Z999")).rejects.toThrow(/500/)
  })
})
