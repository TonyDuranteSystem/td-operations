import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// triggerWorker must self-call the deployment that is ACTUALLY running the code
// that enqueued the job (VERCEL_URL), not a shared stable alias that a different
// concurrent deployment can briefly own (NEXT_PUBLIC_APP_URL). Regression test for
// the 2026-08-23 incident: a job chained by one sandbox deployment was picked up
// by a different deployment that didn't recognize the job type, because the
// self-trigger went through the shared alias instead of this deployment's own URL.
describe("triggerWorker URL selection", () => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.unstubAllGlobals()
  })

  it("prefers VERCEL_URL (this exact deployment) over the shared app alias", async () => {
    process.env.VERCEL_URL = "td-operations-sandbox-abc123-tony-durantes-projects.vercel.app"
    process.env.NEXT_PUBLIC_APP_URL = "https://td-operations-sandbox.vercel.app"

    const { triggerWorker } = await import("@/lib/jobs/queue")
    await triggerWorker()

    expect(fetchMock).toHaveBeenCalledWith(
      "https://td-operations-sandbox-abc123-tony-durantes-projects.vercel.app/api/jobs/process",
      expect.anything(),
    )
  })

  it("falls back to NEXT_PUBLIC_APP_URL when VERCEL_URL is unset", async () => {
    delete process.env.VERCEL_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://portal.tonydurante.us"

    const { triggerWorker } = await import("@/lib/jobs/queue")
    await triggerWorker()

    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.tonydurante.us/api/jobs/process",
      expect.anything(),
    )
  })

  it("falls back to localhost when neither is set", async () => {
    delete process.env.VERCEL_URL
    delete process.env.NEXT_PUBLIC_APP_URL

    const { triggerWorker } = await import("@/lib/jobs/queue")
    await triggerWorker()

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/jobs/process",
      expect.anything(),
    )
  })
})
