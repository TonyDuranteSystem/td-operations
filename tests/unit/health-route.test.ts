/**
 * P2.7 — /api/health route tests.
 *
 * The route itself depends on Supabase so we test it indirectly via a
 * mock on supabase-admin. Verifies:
 *   - missing env vars → 503 + env check fails
 *   - Supabase error → 503 + db check fails
 *   - all green → 200 + ok=true
 *   - response shape includes checks[], elapsed_ms, timestamp, commit_sha
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockFrom = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => mockFrom(t) },
}))

// Re-import GET fresh in each test so env state is picked up correctly.
async function callGET() {
  const mod = await import("@/app/api/health/route")
  return mod.GET()
}

describe("/api/health", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    mockFrom.mockReset()
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key"
    delete process.env.VERCEL_GIT_COMMIT_SHA
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("returns 200 + ok=true when all checks pass", async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        limit: () => Promise.resolve({ error: null, count: 42 }),
      }),
    })

    const res = await callGET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks).toHaveLength(2)
    expect(body.checks.find((c: { name: string }) => c.name === "env").ok).toBe(true)
    expect(body.checks.find((c: { name: string }) => c.name === "db").ok).toBe(true)
    expect(typeof body.elapsed_ms).toBe("number")
    expect(typeof body.timestamp).toBe("string")
    expect(body.commit_sha).toBe("local")
  })

  it("returns 503 + env check fails when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    mockFrom.mockReturnValue({
      select: () => ({ limit: () => Promise.resolve({ error: null, count: 0 }) }),
    })

    const res = await callGET()
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    const envCheck = body.checks.find((c: { name: string }) => c.name === "env")
    expect(envCheck.ok).toBe(false)
    expect(envCheck.detail).toContain("NEXT_PUBLIC_SUPABASE_URL")
  })

  it("returns 503 when Supabase query returns an error", async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        limit: () => Promise.resolve({ error: { message: "connection refused" }, count: null }),
      }),
    })

    const res = await callGET()
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    const dbCheck = body.checks.find((c: { name: string }) => c.name === "db")
    expect(dbCheck.ok).toBe(false)
    expect(dbCheck.detail).toContain("connection refused")
  })

  it("returns 503 when Supabase throws", async () => {
    mockFrom.mockImplementation(() => {
      throw new Error("boom")
    })

    const res = await callGET()
    const body = await res.json()

    expect(res.status).toBe(503)
    const dbCheck = body.checks.find((c: { name: string }) => c.name === "db")
    expect(dbCheck.ok).toBe(false)
    expect(dbCheck.detail).toContain("boom")
  })

  it("surfaces VERCEL_GIT_COMMIT_SHA (short) when present", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef"
    mockFrom.mockReturnValue({
      select: () => ({ limit: () => Promise.resolve({ error: null, count: 0 }) }),
    })

    const res = await callGET()
    const body = await res.json()

    expect(body.commit_sha).toBe("0123456")
  })
})
