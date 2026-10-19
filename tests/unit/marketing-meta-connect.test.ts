import { describe, it, expect, vi, afterEach } from "vitest"
import { connectMeta, type ConnectDeps } from "@/lib/marketing/meta-leads/connect"
import { GraphError, exchangeForLongLived, identityWithKey, listAccountsWithKey, useEnvKeyOnly } from "@/lib/marketing/meta-leads/graph"
import type { SaveInput } from "@/lib/marketing/meta-leads/key-store"

const PERSONAL = "EAAB-personal-key-aaaaaaaaaaaaaaaaaaa"
const LONG = "EAAB-long-lasting-personal-key-bbbbbbbbbb"
const PAGEKEY = "EAAB-the-page-own-key-cccccccccccccccc"

function deps(over: Partial<ConnectDeps> = {}): { d: ConnectDeps; saved: SaveInput[] } {
  const saved: SaveInput[] = []
  const d: ConnectDeps = {
    appId: "999", appSecret: "secret", pageIds: ["101"], userKey: null, envKey: PERSONAL, connectedBy: "antonio@tonydurante.us",
    identity: async key => key === PAGEKEY ? { id: "101", name: "Tony Durante LLC" } : { id: "u1", name: "Tony Durante" },
    exchange: async () => ({ accessToken: LONG, expiresIn: 5184000 }),
    accounts: async key => key === LONG || key === PERSONAL ? [{ id: "101", name: "Tony Durante LLC", access_token: PAGEKEY }, { id: "555", name: "Other Page", access_token: "x" }] : [],
    save: async i => { saved.push(i); return null },
    ...over,
  }
  return { d, saved }
}
const step = (r: Awaited<ReturnType<typeof connectMeta>>, k: string) => r.steps.find(s => s.key === k)!

describe("connectMeta", () => {
  it("personal key -> long-lasting -> the Page's own key, stored", async () => {
    const { d, saved } = deps()
    const r = await connectMeta(d)
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ pageId: "101", pageName: "Tony Durante LLC", key: PAGEKEY, userId: "u1", longLived: true, connectedBy: "antonio@tonydurante.us" })
    expect(step(r, "long").status).toBe("ok")
    expect(step(r, "page_101").detail).toMatch(/does not expire on a clock/)
    expect(r.connectedPages).toEqual([{ id: "101", name: "Tony Durante LLC", longLived: true }])
  })
  it("never puts any key in the report", async () => {
    const r = await connectMeta(deps().d)
    expect(JSON.stringify(r)).not.toMatch(/EAAB/)
  })
  it("prefers the key pasted in the box over the Vercel one", async () => {
    const identity = vi.fn(async (_key: string) => ({ id: "u1", name: "Tony Durante" }))
    await connectMeta(deps({ userKey: "EAAB-pasted-key-dddddddddddddddd", identity }).d)
    expect(identity.mock.calls[0][0]).toBe("EAAB-pasted-key-dddddddddddddddd")
  })
  it("a key that is already the Page's own is stored as is (it cannot be extended)", async () => {
    const { d, saved } = deps({ envKey: PAGEKEY })
    const r = await connectMeta(d)
    expect(r.ok).toBe(true)
    expect(saved[0]).toMatchObject({ pageId: "101", key: PAGEKEY, longLived: false })
    expect(step(r, "lasting").status).toBe("warn")
  })
  it("if Meta will not extend the key it still connects, with a clear warning", async () => {
    const { d, saved } = deps({ exchange: async () => { throw new GraphError("Graph 400: nope", 400, 100) } })
    const r = await connectMeta(d)
    expect(step(r, "long").status).toBe("warn")
    expect(saved[0].longLived).toBe(false)
    expect(step(r, "page_101").status).toBe("warn")
    expect(r.ok).toBe(true)
  })
  it("without the app id it cannot extend, and says so", async () => {
    const exchange = vi.fn()
    const r = await connectMeta(deps({ appId: null, exchange }).d)
    expect(exchange).not.toHaveBeenCalled()
    expect(step(r, "long").detail).toMatch(/app id is not set/)
  })
  it("a personal key that does not manage the Page names the Pages it does manage and stores nothing", async () => {
    const { d, saved } = deps({ accounts: async () => [{ id: "555", name: "Other Page", access_token: "x" }] })
    const r = await connectMeta(d)
    expect(r.ok).toBe(false)
    expect(saved).toHaveLength(0)
    expect(step(r, "page_101").detail).toMatch(/does not manage this Page.*Other Page/)
  })
  it("refuses to store a key that Meta says belongs to a different Page", async () => {
    const { d, saved } = deps({ identity: async key => key === PAGEKEY ? { id: "777", name: "Wrong Page" } : { id: "u1", name: "Tony Durante" } })
    const r = await connectMeta(d)
    expect(r.ok).toBe(false)
    expect(saved).toHaveLength(0)
    expect(step(r, "page_101").detail).toMatch(/Wrong Page.*not to this Page/)
  })
  it("a rejected key stops early with a plain message", async () => {
    const r = await connectMeta(deps({ identity: async () => { throw new GraphError("Graph 400: x", 400, 190) } }).d)
    expect(r.ok).toBe(false)
    expect(step(r, "identity").detail).toMatch(/invalid or has expired/)
  })
  it("missing prerequisites fail in plain words before any Meta call", async () => {
    const identity = vi.fn()
    for (const over of [{ appSecret: null }, { pageIds: [] }, { userKey: null, envKey: null }] as Array<Partial<ConnectDeps>>) {
      const r = await connectMeta(deps({ ...over, identity }).d)
      expect(r.ok).toBe(false)
    }
    expect(identity).not.toHaveBeenCalled()
  })
  it("a storage failure is reported and the connection is not claimed", async () => {
    const r = await connectMeta(deps({ save: async () => "The database table for the connection does not exist yet. Run the SQL for it first." }).d)
    expect(r.ok).toBe(false)
    expect(step(r, "page_101").detail).toMatch(/Run the SQL/)
    expect(r.connectedPages).toEqual([])
  })
  it("an account list failure is explained", async () => {
    const r = await connectMeta(deps({ accounts: async () => { throw new GraphError("Graph 403: (#200) missing", 403, 200) } }).d)
    expect(step(r, "accounts").status).toBe("fail")
    expect(step(r, "accounts").detail).toMatch(/permission/)
  })
})

describe("graph: identity with a given key, accounts, long-lived exchange", () => {
  afterEach(() => { vi.unstubAllEnvs() })
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
  const asFetch = (f: unknown) => f as typeof fetch
  it("identity and accounts use exactly the key given, in a header", async () => {
    useEnvKeyOnly()
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "ENV-KEY-SHOULD-NOT-BE-USED")
    const f = vi.fn(async () => json({ id: "u1", name: "T", data: [{ id: "101", access_token: "k" }] }))
    await identityWithKey("GIVEN-KEY", asFetch(f))
    expect(await listAccountsWithKey("GIVEN-KEY", asFetch(f))).toHaveLength(1)
    for (const c of f.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((c[1].headers as Record<string, string>).Authorization).toBe("Bearer GIVEN-KEY")
      expect(c[0]).not.toContain("GIVEN-KEY")
    }
  })
  it("the extension sends the app secret and key in the BODY of a POST, with no Authorization header, never in the URL", async () => {
    const f = vi.fn(async () => json({ access_token: "LONG", expires_in: 5184000 }))
    expect(await exchangeForLongLived("SHORT-KEY", "999", "the-secret", asFetch(f))).toEqual({ accessToken: "LONG", expiresIn: 5184000 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe("POST")
    expect(url).not.toMatch(/the-secret|SHORT-KEY/)
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    const body = new URLSearchParams(String(init.body))
    expect(body.get("grant_type")).toBe("fb_exchange_token")
    expect(body.get("client_id")).toBe("999")
    expect(body.get("client_secret")).toBe("the-secret")
    expect(body.get("fb_exchange_token")).toBe("SHORT-KEY")
  })
  it("falls back to GET if Meta only accepts that form, but never retries a real refusal about the key", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: "Unsupported post request", code: 100 } }, 400))
      .mockResolvedValueOnce(json({ access_token: "LONG2" }))
    expect((await exchangeForLongLived("K", "999", "s", asFetch(f))).accessToken).toBe("LONG2")
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].method).toBe("GET")
    const g = vi.fn(async () => json({ error: { message: "Error validating access token", code: 190 } }, 400))
    await expect(exchangeForLongLived("K", "999", "s", asFetch(g))).rejects.toBeInstanceOf(GraphError)
    expect(g).toHaveBeenCalledTimes(1)
  })
  it("an answer without a key is an error, not a silent pass", async () => {
    const f = vi.fn(async () => json({}))
    await expect(exchangeForLongLived("K", "999", "s", asFetch(f))).rejects.toThrow(/long-lasting/)
  })
})
