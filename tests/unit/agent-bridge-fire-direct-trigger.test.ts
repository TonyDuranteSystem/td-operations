/**
 * Hermes ↔ Claude bridge — direct-trigger fetch.
 * dev_task 1a0d1354. Pairs with lib/mcp/tools/agent-messages.ts::fireDirectTrigger.
 *
 * agent_msg_send, after insert, POSTs to the worker route with the right URL,
 * header, and method, AWAITS it (bounded by a 3s AbortController timeout) so the
 * request reliably leaves the serverless function before it can freeze, and never
 * throws. The worker route runs the sonnet loop server-side to completion; the
 * timeout just stops agent_msg_send from blocking on it. These tests pin those
 * guarantees with a mocked global.fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { fireDirectTrigger } from "@/lib/mcp/tools/agent-messages"

describe("Hermes ↔ Claude bridge — fireDirectTrigger", () => {
  const originalFetch = global.fetch
  const originalCronSecret = process.env.CRON_SECRET
  const originalAppBaseUrl = process.env.APP_BASE_URL
  const originalVercelUrl = process.env.VERCEL_URL
  const originalVercelProdUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL

  beforeEach(() => {
    // Reset env per test
    delete process.env.CRON_SECRET
    delete process.env.APP_BASE_URL
    delete process.env.VERCEL_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalCronSecret !== undefined) process.env.CRON_SECRET = originalCronSecret
    if (originalAppBaseUrl !== undefined) process.env.APP_BASE_URL = originalAppBaseUrl
    if (originalVercelUrl !== undefined) process.env.VERCEL_URL = originalVercelUrl
    if (originalVercelProdUrl !== undefined) process.env.VERCEL_PROJECT_PRODUCTION_URL = originalVercelProdUrl
  })

  it("posts to /api/cron/hermes-bridge with message_id, CRON_SECRET, POST method, and an abort signal", async () => {
    process.env.CRON_SECRET = "test-secret-abc"
    process.env.APP_BASE_URL = "https://sandbox.example.com"

    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null, { status: 200 })))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await fireDirectTrigger("11111111-1111-1111-1111-111111111111")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://sandbox.example.com/api/cron/hermes-bridge?message_id=11111111-1111-1111-1111-111111111111")
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer test-secret-abc" },
    })
    // Bounded by a timeout so agent_msg_send can't hang Hermes.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("URL-encodes the message_id (defensive — UUIDs don't need it, but principle stands)", async () => {
    process.env.CRON_SECRET = "x"
    process.env.APP_BASE_URL = "https://e.example.com"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await fireDirectTrigger("with/odd&chars")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toContain("message_id=with%2Fodd%26chars")
  })

  it("falls back to the project's STABLE production alias (VERCEL_PROJECT_PRODUCTION_URL) when APP_BASE_URL is unset", async () => {
    process.env.CRON_SECRET = "x"
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "td-operations-sandbox.vercel.app"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await fireDirectTrigger("msg-1")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toMatch(/^https:\/\/td-operations-sandbox\.vercel\.app\/api\/cron\/hermes-bridge/)
  })

  it("NEVER uses the deployment-specific VERCEL_URL — it is behind Vercel Deployment Protection (401s self-calls; the root cause of claimed_at=null)", async () => {
    process.env.CRON_SECRET = "x"
    // Deployment-specific host present, but no stable alias / override.
    process.env.VERCEL_URL = "td-operations-deadbeef-proj.vercel.app"
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "td-operations.vercel.app"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await fireDirectTrigger("msg-x")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).not.toContain("deadbeef")
    expect(url).toMatch(/^https:\/\/td-operations\.vercel\.app\/api\/cron\/hermes-bridge/)
  })

  it("falls back to localhost when no override and no VERCEL_PROJECT_PRODUCTION_URL are set (dev mode)", async () => {
    process.env.CRON_SECRET = "x"
    const fetchSpy = vi.fn().mockReturnValue(Promise.resolve(new Response(null)))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await fireDirectTrigger("msg-2")

    const [url] = fetchSpy.mock.calls[0]
    expect(url).toMatch(/^http:\/\/localhost:3000\/api\/cron\/hermes-bridge/)
  })

  it("skips the fetch when CRON_SECRET is not set (don't fire an unauthenticated request)", async () => {
    process.env.APP_BASE_URL = "https://e.example.com"
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await expect(fireDirectTrigger("msg-3")).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not throw/reject when fetch fails or aborts — the cron safety net is the fallback", async () => {
    process.env.CRON_SECRET = "x"
    process.env.APP_BASE_URL = "https://e.example.com"
    const fetchSpy = vi.fn().mockReturnValue(Promise.reject(new Error("network down")))
    global.fetch = fetchSpy as unknown as typeof global.fetch

    // The error (incl. an AbortError from the timeout) is caught internally.
    await expect(fireDirectTrigger("msg-4")).resolves.toBeUndefined()
  })
})
