import { describe, it, expect, vi, afterEach } from "vitest"
import { callApi, messageOf } from "@/components/address-book/api"

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("the address book's way of calling its routes", () => {
  it("a call that changes something always sends the JSON header the same-origin check needs — even a DELETE with nothing to send", async () => {
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const fn = stubFetch(200, { ok: true })
      await callApi("/api/address-book/people/x", { method })
      const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1]
      const headers = new Headers(init.headers)
      expect(headers.get("content-type"), method).toBe("application/json")
      expect(init.body, method).toBe("{}")
    }
  })
  it("a read sends no body and no header", async () => {
    const fn = stubFetch(200, { rows: [] })
    await callApi("/api/address-book")
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.method).toBe("GET")
    expect(init.body).toBeUndefined()
    expect(init.headers).toBeUndefined()
  })
  it("sends the given body as JSON", async () => {
    const fn = stubFetch(200, { id: "1" })
    await callApi("/api/address-book/people", { method: "POST", body: { full_name: "A" } })
    expect((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe('{"full_name":"A"}')
  })
  it("a refusal surfaces the server's own words and keeps the status and data (R099)", async () => {
    stubFetch(409, { error: "Tom (saved here) already has this phone or email.", matches: [{ key: "saved:1" }] })
    await expect(callApi("/x", { method: "POST", body: {} })).rejects.toMatchObject({ message: "Tom (saved here) already has this phone or email.", status: 409, data: { matches: [{ key: "saved:1" }] } })
  })
  it("a refusal with no words falls back to the given sentence; a dropped connection says so", async () => {
    stubFetch(500, {})
    await expect(callApi("/x", {}, "Could not do it.")).rejects.toThrow("Could not do it.")
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    await expect(callApi("/x")).rejects.toThrow(/connection dropped/i)
  })
  it("messageOf uses the error's words or the fallback", () => {
    expect(messageOf(new Error("Plain words."))).toBe("Plain words.")
    expect(messageOf("nope", "Fallback.")).toBe("Fallback.")
    expect(messageOf(new Error(""), "Fallback.")).toBe("Fallback.")
  })
})
