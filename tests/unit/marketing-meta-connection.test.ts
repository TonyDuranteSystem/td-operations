import { describe, it, expect, vi, afterEach } from "vitest"
import { checkMetaConnection, explainGraphError, subscribePages, type ConnectionDeps } from "@/lib/marketing/meta-leads/connection"
import { GraphError, fetchTokenIdentity, listPageSubscribedApps, subscribePageToLeads } from "@/lib/marketing/meta-leads/graph"

const env = { appSecret: true, verifyToken: true, pageToken: true, pageIds: ["101"], appId: "999" }
const deps = (over: Partial<ConnectionDeps> = {}): ConnectionDeps => ({
  env,
  identity: async () => ({ id: "101", name: "Tony Durante LLC" }),
  subscribedApps: async () => [{ id: "999", name: "TD Marketing Leads", subscribed_fields: ["leadgen"] }],
  forms: async () => [{ id: "1", name: "LLC ITA form", status: "ACTIVE" }],
  ...over,
})
const by = (r: Awaited<ReturnType<typeof checkMetaConnection>>, key: string) => r.checks.find(c => c.key === key)!

describe("checkMetaConnection", () => {
  it("everything fine = ok, in plain words", async () => {
    const r = await checkMetaConnection(deps())
    expect(r.ok).toBe(true)
    expect(r.checks.every(c => c.status === "ok")).toBe(true)
    expect(by(r, "token").detail).toContain("Tony Durante LLC")
    expect(by(r, "forms_101").detail).toContain("LLC ITA form")
  })
  it("missing settings fail and the Meta calls are skipped", async () => {
    const identity = vi.fn()
    const r = await checkMetaConnection(deps({ env: { appSecret: false, verifyToken: false, pageToken: false, pageIds: [], appId: null }, identity }))
    expect(r.ok).toBe(false)
    expect(["app_secret", "verify_token", "page_token", "page_ids"].every(k => by(r, k).status === "fail")).toBe(true)
    expect(by(r, "token").status).toBe("skip")
    expect(identity).not.toHaveBeenCalled()
  })
  it("a rejected key stops the check with a clear message", async () => {
    const r = await checkMetaConnection(deps({ identity: async () => { throw new GraphError("Graph 400: Error validating access token", 400, 190) } }))
    expect(r.ok).toBe(false)
    expect(by(r, "token").status).toBe("fail")
    expect(by(r, "token").detail).toMatch(/invalid or has expired/)
    expect(r.checks.some(c => c.key.startsWith("subscribed_"))).toBe(false)
  })
  it("a key that belongs to a different Page is a warning", async () => {
    const r = await checkMetaConnection(deps({ identity: async () => ({ id: "555", name: "Other Page" }) }))
    expect(by(r, "token").status).toBe("warn")
    expect(r.ok).toBe(false)
  })
  it("not subscribed (nothing installed) fails and points at the button", async () => {
    const r = await checkMetaConnection(deps({ subscribedApps: async () => [] }))
    expect(by(r, "subscribed_101").status).toBe("fail")
    expect(by(r, "subscribed_101").detail).toMatch(/Subscribe button/)
  })
  it("another app installed but not ours is not subscribed", async () => {
    const r = await checkMetaConnection(deps({ subscribedApps: async () => [{ id: "123", name: "ZantaTech", subscribed_fields: ["leadgen"] }] }))
    expect(by(r, "subscribed_101").status).toBe("fail")
    expect(by(r, "subscribed_101").detail).toMatch(/1 other app/)
  })
  it("ours installed but without the leadgen field fails", async () => {
    const r = await checkMetaConnection(deps({ subscribedApps: async () => [{ id: "999", subscribed_fields: ["feed"] }] }))
    expect(by(r, "subscribed_101").status).toBe("fail")
  })
  it("without our app id it warns instead of guessing", async () => {
    const r = await checkMetaConnection(deps({ env: { ...env, appId: null } }))
    expect(by(r, "app_id").status).toBe("warn")
    expect(by(r, "subscribed_101").status).toBe("warn")
  })
  it("no lead forms visible is a warning that names the likely cause", async () => {
    const r = await checkMetaConnection(deps({ forms: async () => [] }))
    expect(by(r, "forms_101").status).toBe("warn")
    expect(by(r, "forms_101").detail).toMatch(/access to the Page's leads/)
  })
  it("one Page failing does not hide the other", async () => {
    const r = await checkMetaConnection(deps({
      env: { ...env, pageIds: ["101", "202"] }, identity: async () => ({ id: "101", name: "A" }),
      forms: async p => { if (p === "202") throw new GraphError("Graph 403: nope", 403, 200); return [{ id: "1", name: "F" }] },
    }))
    expect(by(r, "forms_101").status).toBe("ok")
    expect(by(r, "forms_202").status).toBe("fail")
  })
  it("never puts a secret value in any result", async () => {
    const r = await checkMetaConnection(deps())
    expect(JSON.stringify(r)).not.toMatch(/secret-value|EAAB/)
  })
})

describe("explainGraphError", () => {
  it("says what to do for the common failures", () => {
    expect(explainGraphError(new GraphError("META_PAGE_ACCESS_TOKEN is not set", null))).toMatch(/not set on the server/)
    expect(explainGraphError(new GraphError("Graph 400: bad", 400, 190))).toMatch(/expired/)
    expect(explainGraphError(new GraphError("Graph 403: (#200) Requires pages_manage_metadata", 403, 200))).toMatch(/permission.*pages_manage_metadata/)
    expect(explainGraphError(new GraphError("Graph 400: x", 400, 4))).toMatch(/limiting/)
    expect(explainGraphError(new GraphError("Graph 500", 500))).toMatch(/temporary/)
    const abort = new Error("The operation was aborted due to timeout"); abort.name = "TimeoutError"
    expect(explainGraphError(abort)).toMatch(/did not answer/)
  })
})

describe("subscribePages", () => {
  it("reports each Page on its own", async () => {
    const r = await subscribePages(["1", "2", "3"], async p => { if (p === "2") throw new GraphError("Graph 400: x", 400, 190); return p === "1" })
    expect(r.map(x => x.ok)).toEqual([true, false, false])
    expect(r[1].detail).toMatch(/expired/)
    expect(r[2].detail).toMatch(/did not confirm/)
  })
})

describe("graph: identity, subscribed apps, subscribe", () => {
  afterEach(() => { vi.unstubAllEnvs() })
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  it("identity and the list are GETs with the key in a header", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "EAAB-secret")
    const f = vi.fn(async () => json({ id: "101", name: "P", data: [{ id: "999" }] }))
    expect(await fetchTokenIdentity(f as unknown as typeof fetch)).toMatchObject({ id: "101" })
    expect(await listPageSubscribedApps("101", f as unknown as typeof fetch)).toHaveLength(1)
    for (const c of f.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(c[1].method).toBe("GET")
      expect(c[0]).not.toContain("EAAB-secret")
      expect((c[1].headers as Record<string, string>).Authorization).toBe("Bearer EAAB-secret")
    }
  })
  it("subscribe is a POST with the field in the body and the key in a header, never the URL", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "EAAB-secret")
    const f = vi.fn(async () => json({ success: true }))
    expect(await subscribePageToLeads("101", f as unknown as typeof fetch)).toBe(true)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/101\/subscribed_apps$/)
    expect(init.method).toBe("POST")
    expect(String(init.body)).toBe("subscribed_fields=leadgen")
    expect(url).not.toContain("EAAB-secret")
    expect(String(init.body)).not.toContain("EAAB-secret")
  })
  it("subscribe returns false when Meta does not say success, and refuses a bad page id before any call", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "t")
    const f = vi.fn(async () => json({ success: false }))
    expect(await subscribePageToLeads("101", f as unknown as typeof fetch)).toBe(false)
    await expect(subscribePageToLeads("1/../me", f as unknown as typeof fetch)).rejects.toThrow()
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("keeps Meta's error code on the error", async () => {
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "t")
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad token", code: 190 } }), { status: 401 }))
    const e = await fetchTokenIdentity(f as unknown as typeof fetch).catch(x => x as GraphError)
    expect(e.code).toBe(190)
    expect(e.status).toBe(401)
  })
})
