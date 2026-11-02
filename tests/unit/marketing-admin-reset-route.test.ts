/**
 * TD Marketing (dev job 9aec66fa): the admin Teams page's "Reset password" route. Only an admin login may use it; it acts as the admin (so a team owner such as Rocco can be reset by Antonio),
 * passes the team and person from the address, and answers a refusal as written, never a link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getUser = vi.fn()
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock("@/lib/auth", () => ({ isSecureAdmin: (u: { admin?: boolean }) => u.admin === true }))
const createOwnerReset = vi.fn()
vi.mock("@/lib/marketing/password-reset", () => ({ createOwnerReset: (i: unknown) => createOwnerReset(i) }))

import { POST } from "@/app/api/marketing-admin/teams/[id]/members/[userId]/reset/route"

const TEAM = "11111111-1111-4111-8111-111111111111"
const PERSON = "22222222-2222-4222-8222-222222222222"
const call = () => POST(new NextRequest(`http://x/api/marketing-admin/teams/${TEAM}/members/${PERSON}/reset`, { method: "POST" }), { params: Promise.resolve({ id: TEAM, userId: PERSON }) })

beforeEach(() => { getUser.mockReset(); createOwnerReset.mockReset() })

describe("POST /api/marketing-admin/teams/[id]/members/[userId]/reset", () => {
  it("nobody signed in: 403, and nothing is made", async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await call()
    expect(res.status).toBe(403)
    expect(createOwnerReset).not.toHaveBeenCalled()
  })
  it("a login that is not an admin (a team owner, a setter): 403, and nothing is made", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "rocco@example.test", admin: false } } })
    const res = await call()
    expect(res.status).toBe(403)
    expect(createOwnerReset).not.toHaveBeenCalled()
  })
  it("an admin: the link is made AS THE ADMIN for the team and person in the address, and is never cached", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1", email: "antonio@example.test", admin: true } } })
    createOwnerReset.mockResolvedValue({ ok: true, data: { resetUrl: "https://app.example/marketing/reset?token=abc", expiresAt: "2026-11-03T00:00:00.000Z", email: "rocco@example.test" } })
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(await res.json()).toEqual({ ok: true, resetUrl: "https://app.example/marketing/reset?token=abc", expiresAt: "2026-11-03T00:00:00.000Z", email: "rocco@example.test" })
    expect(createOwnerReset).toHaveBeenCalledWith({ teamId: TEAM, userId: PERSON, actor: { kind: "admin", userId: "admin-1", label: "antonio@example.test", permissions: [] } })
  })
  it("an admin without an email on the login is still labelled (by id), so the hourly limit counts him", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-2", email: null, admin: true } } })
    createOwnerReset.mockResolvedValue({ ok: true, data: { resetUrl: "u", expiresAt: "e", email: "x@example.test" } })
    await call()
    expect(createOwnerReset).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ label: "admin-2" }) }))
  })
  it("a refusal is shown as written (400, no link)", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1", email: "antonio@example.test", admin: true } } })
    createOwnerReset.mockResolvedValue({ ok: false, error: "Resume this person first, then make the link." })
    const res = await call()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: "Resume this person first, then make the link." })
    expect(JSON.stringify(body)).not.toMatch(/token/)
  })
  it("a refusal with no message still answers in plain words", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1", email: "antonio@example.test", admin: true } } })
    createOwnerReset.mockResolvedValue({ ok: false })
    const res = await call()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Something went wrong. Please try again.")
  })
})
