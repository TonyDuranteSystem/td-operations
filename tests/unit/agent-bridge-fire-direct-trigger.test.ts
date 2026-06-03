/**
 * Hermes ↔ Claude bridge — direct-trigger fetch (fire-and-forget).
 * dev_task 1a0d1354. Pairs with lib/mcp/tools/agent-messages.ts::fireDirectTrigger.
 *
 * The MCP tool agent_msg_send must, after insert, POST to the worker route
 * with the right URL, header, and method — but MUST NOT await. These tests
 * pin those guarantees with a mocked global.fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { fireDirectTrigger } from "@/lib/mcp/tools/agent-messages"

describe("Hermes ↔ Claude bridge — fireDirectTrigger", () => {
  const originalFetch = global.fetch
  const originalCronSecret = process.env.CRON_SECRET
  const originalAppBaseUrl = process.env.APP_BASE_URL
  const originalVercelUrl = process.env.VERCEL_URL

  beforeEach(() => {
    // Reset env per test
    delete process.env.CRON_SECRET
    delete process.env.APP_BASE_URL
    delete process.env.VERCEL_URL
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalCronSecret !== undefined) process.env.CRON_SECRET = originalCronSecret
    if (originalAppBaseUrl !== undefined) process.env.APP_BASE_URL = originalAppBaseUrl
    if (originalVercelUrl !== undefined) process.env.VERCEL_URL = originalVercelUrl
  })

  it("posts to /api/cron/hermes-bridge with message_id, CRON_SECRET, and POST method", () => {
    process.env.CRON_SECRET = "test-secret-abc"
    process.env.APP_BASE_URL = "https://sandbox.example.com"

    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null, { status: 200 })))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    fireDirectTrigger("11111111-1111-1111-1111-111111111111")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://sandbox.example.com/api/cron/hermes-bridge?message_id=11111111-1111-1111-1111-111111111111")
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer test-secret-abc" },
    })
  })

  it("URL-encodes the message_id (defensive — UUIDs don't need it, but principle stands)", () => {
    process.env.CRON_SECRET = "x"
    process.env.APP_BASE_URL = "https://e.example.com"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    fireDirectTrigger("with/odd&chars")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toContain("message_id=with%2Fodd%26chars")
  })

  it("falls back to a https URL built from VERCEL_URL when APP_BASE_URL is unset", () => {
    process.env.CRON_SECRET = "x"
    process.env.VERCEL_URL = "td-operations-sandbox.vercel.app"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    fireDirectTrigger("msg-1")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toMatch(/^https:\/\/td-operations-sandbox\.vercel\.app\/api\/cron\/hermes-bridge/)
  })

  it("falls back to localhost when both VERCEL_URL and APP_BASE_URL are unset (dev mode)", () => {
    process.env.CRON_SECRET = "x"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    fireDirectTrigger("msg-2")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toMatch(/^http:\/\/localhost:3000\/api\/cron\/hermes-bridge/)
  })

  it("skips the fetch when CRON_SECRET is not set (don't fire an unauthenticated request)", () => {
    process.env.APP_BASE_URL = "https://e.example.com"
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof global.fetch

    // Should not throw, should not call fetch.
    expect(() => fireDirectTrigger("msg-3")).not.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not throw when fetch rejects — the cron safety net is the fallback", async () => {
    process.env.CRON_SECRET = "x"
    process.env.APP_BASE_URL = "https://e.example.com"
    const fetchSpy = vi.fn().mockReturnValue(Promise.reject(new Error("network down")))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    expect(() => fireDirectTrigger("msg-4")).not.toThrow()
    // Give the rejection a microtask to surface — the .catch() in
    // fireDirectTrigger swallows it.
    await Promise.resolve()
  })
})
