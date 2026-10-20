import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { configuredPageIds, fetchLead, GraphError, listFormLeads, useEnvKeyOnly } from "@/lib/marketing/meta-leads/graph"

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const asFetch = (f: unknown) => f as typeof fetch
beforeEach(() => { useEnvKeyOnly() })
afterEach(() => { vi.unstubAllEnvs() })

describe("graph client", () => {
  it("sends the token in a header, never in the URL", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "EAAB-secret-token")
    const f = vi.fn(async () => ok({ id: "9001" }))
    await fetchLead("9001", asFetch(f))
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain("EAAB-secret-token")
    expect(url).not.toContain("access_token")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer EAAB-secret-token")
    expect(url).toContain("/9001?fields=")
  })
  it("uses the configured version, falling back on a bad value", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "t")
    const f = vi.fn(async () => ok({ id: "1" }))
    vi.stubEnv("META_GRAPH_VERSION", "v26.0"); await fetchLead("1", asFetch(f))
    vi.stubEnv("META_GRAPH_VERSION", "../evil"); await fetchLead("1", asFetch(f))
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain("/v26.0/1")
    expect((f.mock.calls[1] as unknown as [string])[0]).toContain("/v25.0/1")
  })
  it("refuses without a token and rejects a non-numeric id before any network call", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "")
    const f = vi.fn()
    await expect(fetchLead("1", asFetch(f))).rejects.toBeInstanceOf(GraphError)
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "t")
    expect(() => fetchLead("1/../me", asFetch(f))).toThrow()
    expect(f).not.toHaveBeenCalled()
  })
  it("turns a Meta error into a short readable message and never echoes the token", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "EAAB-secret-token")
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Error validating access token: Session has expired" } }), { status: 400 }))
    const err = (await fetchLead("1", asFetch(f)).catch(e => e)) as Error
    expect(String(err.message)).toMatch(/Graph 400: Error validating access token/)
    expect(String(err.message)).not.toContain("EAAB-secret-token")
  })
  it("only ever talks to Meta (or a loopback test double): any other host in the setting is ignored", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "t")
    const f = vi.fn(async () => ok({ id: "1" }))
    vi.stubEnv("META_GRAPH_BASE_URL", "https://evil.example.com"); await fetchLead("1", asFetch(f))
    vi.stubEnv("META_GRAPH_BASE_URL", "http://127.0.0.1:4010"); await fetchLead("1", asFetch(f))
    vi.stubEnv("META_GRAPH_BASE_URL", "http://127.0.0.1.evil.com:4010"); await fetchLead("1", asFetch(f))
    const urls = f.mock.calls.map(c => (c as unknown as [string])[0])
    expect(urls[0]).toMatch(/^https:\/\/graph\.facebook\.com\//)
    expect(urls[1]).toMatch(/^http:\/\/127\.0\.0\.1:4010\//)
    expect(urls[2]).toMatch(/^https:\/\/graph\.facebook\.com\//)
  })
  it("lists a form's leads", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "t")
    const f = vi.fn(async () => ok({ data: [{ id: "1" }, { id: "2" }] }))
    expect(await listFormLeads("222", asFetch(f))).toHaveLength(2)
  })
  it("configuredPageIds keeps only numeric ids", () => {
    vi.stubEnv("META_PAGE_IDS", "801873779682189, bad ,397947200076215,,1/2")
    expect(configuredPageIds()).toEqual(["801873779682189", "397947200076215"])
  })
})
