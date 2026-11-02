/**
 * TD Marketing (dev job 9aec66fa): the admin Teams page's "Send by email" route for a reset link. Only an admin login; preview by default, a send only when `send` is exactly true; a refusal is shown as written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getUser = vi.fn()
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock("@/lib/auth", () => ({ isSecureAdmin: (u: { admin?: boolean }) => u.admin === true }))
const previewResetEmail = vi.fn()
const sendResetEmail = vi.fn()
vi.mock("@/lib/marketing/reset-email-server", () => ({
  previewResetEmail: (...a: unknown[]) => previewResetEmail(...a),
  sendResetEmail: (...a: unknown[]) => sendResetEmail(...a),
}))

import { POST } from "@/app/api/marketing-admin/resets/email/route"

const post = (rawBody: string | null) => POST(new NextRequest("http://x/api/marketing-admin/resets/email", { method: "POST", body: rawBody, headers: { "content-type": "application/json" } }))
const ADMIN = { id: "admin-1", email: "antonio@example.test", admin: true }

beforeEach(() => { getUser.mockReset(); previewResetEmail.mockReset(); sendResetEmail.mockReset() })

describe("POST /api/marketing-admin/resets/email", () => {
  it("nobody signed in, or a login that is not an admin: 403 and nothing is read or sent", async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    expect((await post(JSON.stringify({ token: "t", send: true }))).status).toBe(403)
    getUser.mockResolvedValue({ data: { user: { id: "u", email: "rocco@example.test", admin: false } } })
    expect((await post(JSON.stringify({ token: "t", send: true }))).status).toBe(403)
    expect(previewResetEmail).not.toHaveBeenCalled()
    expect(sendResetEmail).not.toHaveBeenCalled()
  })
  it("default is a preview (nothing is sent), as the admin", async () => {
    getUser.mockResolvedValue({ data: { user: ADMIN } })
    previewResetEmail.mockResolvedValue({ ok: true, data: { to: "rocco@example.test", from: "support@tonydurante.us", replyTo: "antonio@example.test", subject: "S", html: "<p>x</p>", lang: "it" } })
    const res = await post(JSON.stringify({ token: "tok", lang: "en" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect((await res.json()).to).toBe("rocco@example.test")
    expect(previewResetEmail).toHaveBeenCalledWith("tok", "antonio@example.test", "en")
    expect(sendResetEmail).not.toHaveBeenCalled()
  })
  it("send only when `send` is exactly true", async () => {
    getUser.mockResolvedValue({ data: { user: ADMIN } })
    previewResetEmail.mockResolvedValue({ ok: true, data: {} })
    await post(JSON.stringify({ token: "tok", send: "true" }))
    await post(JSON.stringify({ token: "tok", send: 1 }))
    expect(sendResetEmail).not.toHaveBeenCalled()
    sendResetEmail.mockResolvedValue({ ok: true, data: { to: "rocco@example.test", from: "support@tonydurante.us", sentAt: "2026-11-02T00:00:00.000Z" } })
    const res = await post(JSON.stringify({ token: "tok", send: true }))
    expect(res.status).toBe(200)
    expect(sendResetEmail).toHaveBeenCalledWith("tok", "antonio@example.test", undefined)
  })
  it("a refusal keeps its status and words", async () => {
    getUser.mockResolvedValue({ data: { user: ADMIN } })
    sendResetEmail.mockResolvedValue({ ok: false, error: "The email could not be sent. Nothing was sent; try again, or copy the link.", status: 502 })
    const res = await post(JSON.stringify({ token: "tok", send: true }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Nothing was sent/)
  })
  it.each(["null", "[]", "\"text\"", "not json", ""])("a body of %j is passed on as no token (the server refuses it), never a crash", async rawBody => {
    getUser.mockResolvedValue({ data: { user: ADMIN } })
    previewResetEmail.mockResolvedValue({ ok: false, error: "This link cannot be used. Ask for a new one.", status: 400 })
    const res = await post(rawBody)
    expect(res.status).toBe(400)
    expect(previewResetEmail).toHaveBeenCalledWith(undefined, "antonio@example.test", undefined)
  })
})
