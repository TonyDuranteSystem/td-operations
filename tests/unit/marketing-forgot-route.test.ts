/**
 * TD Marketing (dev job 9aec66fa): the two public routes of the password reset. A request with a broken body is answered normally (not a server crash), and the Forgot page is slowed down per place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requestForgotPassword = vi.fn(async (_i: { email: unknown; lang?: unknown }) => ({ valid: true }))
const completeReset = vi.fn(async (_i: { token: unknown; password: unknown }) => ({ ok: false, error: "This link cannot be used. Ask for a new one." }))
vi.mock("@/lib/marketing/password-reset", () => ({
  requestForgotPassword: (i: { email: unknown; lang?: unknown }) => requestForgotPassword(i),
  completeReset: (i: { token: unknown; password: unknown }) => completeReset(i),
}))

import { POST as forgot } from "@/app/api/marketing/forgot/route"
import { POST as reset } from "@/app/api/marketing/reset/route"
import { FORGOT_ANSWER, FORGOT_MAX_PER_MINUTE } from "@/lib/marketing/reset-rules"

let n = 0
const post = (path: string, rawBody: string | null, ip = `10.0.0.${++n}`) =>
  new NextRequest(`https://app.example${path}`, { method: "POST", body: rawBody, headers: { "x-forwarded-for": ip, "content-type": "application/json" } })

beforeEach(() => { requestForgotPassword.mockClear(); completeReset.mockClear() })

describe("POST /api/marketing/forgot", () => {
  it("a normal request gets the one answer", async () => {
    const res = await forgot(post("/api/marketing/forgot", JSON.stringify({ email: "rocco@example.test", lang: "en" })))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe(FORGOT_ANSWER)
    expect(requestForgotPassword).toHaveBeenCalledWith({ email: "rocco@example.test", lang: "en" })
  })
  it.each(["null", "[]", "\"text\"", "42", "not json", ""])("a body of %j is a normal 'not valid' (400), never a crash", async raw => {
    requestForgotPassword.mockResolvedValueOnce({ valid: false })
    const res = await forgot(post("/api/marketing/forgot", raw))
    expect(res.status).toBe(400)
  })
  it("the same place is slowed down after a few requests - matched or not - and other places are not", async () => {
    const ip = "203.0.113.50"
    for (let i = 0; i < FORGOT_MAX_PER_MINUTE; i++) expect((await forgot(post("/api/marketing/forgot", JSON.stringify({ email: "a@b.co" }), ip))).status).toBe(200)
    const blocked = await forgot(post("/api/marketing/forgot", JSON.stringify({ email: "a@b.co" }), ip))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("Retry-After")).toBeTruthy()
    expect((await blocked.json()).error).toMatch(/Too many attempts/)
    expect(requestForgotPassword).toHaveBeenCalledTimes(FORGOT_MAX_PER_MINUTE)
    expect((await forgot(post("/api/marketing/forgot", JSON.stringify({ email: "a@b.co" }), "203.0.113.51"))).status).toBe(200)
  })
})

describe("POST /api/marketing/reset", () => {
  it.each(["null", "[]", "\"text\"", "not json", ""])("a body of %j is refused with the generic answer (400), never a crash", async raw => {
    const res = await reset(post("/api/marketing/reset", raw))
    expect(res.status).toBe(400)
    expect(completeReset).toHaveBeenCalledWith({ token: undefined, password: undefined })
  })
})
