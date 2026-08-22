/**
 * POST /api/system-errors/report — auth boundary.
 *
 * Built for dev job 61f62c08: the portal service worker's push handler needs
 * to self-report a failed app-icon badge, but a background push event cannot
 * be assumed to carry a valid session — confirmed live (the SW's report was
 * silently 401ing). The fix opens ONE narrow, allowlisted exception; every
 * other route must stay exactly as auth-gated as before. These tests pin
 * that boundary so it can't quietly widen.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const authFixture: { user: { id: string; email: string } | null } = { user: null }

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: authFixture.user } }),
    },
  }),
}))

const reportSystemErrorMock = vi.fn(async (..._args: unknown[]) => ({ fingerprint: "fp-1" }))
vi.mock("@/lib/system-errors", () => ({
  reportSystemError: (...args: unknown[]) => reportSystemErrorMock(...args),
}))

import { POST } from "@/app/api/system-errors/report/route"

function postFrom(ip: string, body: unknown) {
  return new NextRequest("https://t/api/system-errors/report", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authFixture.user = null
  reportSystemErrorMock.mockClear()
})

describe("POST /api/system-errors/report — auth boundary", () => {
  it("authenticated user on any route → unchanged: captured with their email", async () => {
    authFixture.user = { id: "u1", email: "staff@tonydurante.us" }
    const res = await POST(postFrom("10.0.0.1", { route: "create-offer-dialog", message: "boom" }))
    expect(res.status).toBe(200)
    expect(reportSystemErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ route: "create-offer-dialog", user_email: "staff@tonydurante.us" }),
    )
  })

  it("unauthenticated, route NOT on the allowlist → still 401, nothing captured", async () => {
    const res = await POST(postFrom("10.0.0.2", { route: "create-offer-dialog", message: "boom" }))
    expect(res.status).toBe(401)
    expect(reportSystemErrorMock).not.toHaveBeenCalled()
  })

  it("unauthenticated, allowlisted badge-diagnostic route → captured with no email", async () => {
    const res = await POST(
      postFrom("10.0.0.3", { route: "portal-sw:push:setAppBadge", message: "setAppBadge() rejected: x" }),
    )
    expect(res.status).toBe(200)
    expect(reportSystemErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ route: "portal-sw:push:setAppBadge", user_email: null, source: "client" }),
    )
  })

  it("unauthenticated, allowlisted route, over the rate limit → 429, no new capture", async () => {
    const ip = "10.0.0.4"
    for (let i = 0; i < 20; i++) {
      await POST(postFrom(ip, { route: "portal-sw:push:setAppBadge", message: "m" }))
    }
    reportSystemErrorMock.mockClear()
    const res = await POST(postFrom(ip, { route: "portal-sw:push:setAppBadge", message: "one too many" }))
    expect(res.status).toBe(429)
    expect(reportSystemErrorMock).not.toHaveBeenCalled()
  })

  it("missing route or message → 400 regardless of auth", async () => {
    authFixture.user = { id: "u1", email: "staff@tonydurante.us" }
    const res = await POST(postFrom("10.0.0.5", { message: "no route" }))
    expect(res.status).toBe(400)
    expect(reportSystemErrorMock).not.toHaveBeenCalled()
  })
})
