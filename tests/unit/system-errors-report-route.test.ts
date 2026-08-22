/**
 * POST /api/system-errors/report — auth boundary + dedup-bypass guard.
 *
 * Built for dev job 61f62c08: the portal service worker's push handler needs
 * to self-report a failed app-icon badge, but a background push event cannot
 * be assumed to carry a valid session — confirmed live (the SW's report was
 * silently 401ing). The fix opens ONE narrow, allowlisted exception; every
 * other route must stay exactly as auth-gated as before. These tests pin
 * that boundary so it can't quietly widen.
 *
 * Second pass (same day, bug-hunter adversarial review): the first version
 * shipped a false safety claim in its own comments — an unauthenticated
 * caller could vary the free-text `message` per request to defeat dedup and
 * flood the row list. canonicalizeUnauthMessage() closes that; the tests
 * below reproduce the exact attack (message varied per request) and assert
 * it now collapses to one fixed value instead of flooding.
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

  it("unauthenticated, allowlisted badge-diagnostic route → captured with no email, message canonicalized", async () => {
    const res = await POST(
      postFrom("10.0.0.3", { route: "portal-sw:push:setAppBadge", message: "setAppBadge() rejected: NotAllowedError" }),
    )
    expect(res.status).toBe(200)
    expect(reportSystemErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "portal-sw:push:setAppBadge",
        user_email: null,
        source: "client",
        message: "setAppBadge() rejected",
        context: expect.objectContaining({ raw_message: "setAppBadge() rejected: NotAllowedError" }),
      }),
    )
  })

  it("dedup-bypass attack: varying the message per request no longer produces distinct fingerprint-relevant messages", async () => {
    const attackerMessages = [
      "setAppBadge() rejected: alpha-payload-1",
      "setAppBadge() rejected: beta-payload-2",
      "setAppBadge() rejected: gamma-payload-3",
    ]
    const seen: unknown[] = []
    for (const message of attackerMessages) {
      reportSystemErrorMock.mockClear()
      await POST(postFrom("10.0.0.6", { route: "portal-sw:push:setAppBadge", message }))
      const call = reportSystemErrorMock.mock.calls[0]?.[0] as { message?: string } | undefined
      seen.push(call?.message)
    }
    // All three attacker-varied messages must collapse to the SAME canonical
    // value — otherwise each one hashes to a distinct fingerprint and dedup
    // (the entire point of this endpoint's rate/volume story) never engages.
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBe("setAppBadge() rejected")
  })

  it("unrecognized message shape on the allowlisted route still collapses to a fixed fallback, not passed through raw", async () => {
    const res = await POST(
      postFrom("10.0.0.7", { route: "portal-sw:push:setAppBadge", message: "totally-unexpected-attacker-text" }),
    )
    expect(res.status).toBe(200)
    expect(reportSystemErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "setAppBadge: unrecognized outcome" }),
    )
  })

  it("authenticated caller's message is passed through unchanged, never canonicalized", async () => {
    authFixture.user = { id: "u1", email: "staff@tonydurante.us" }
    const res = await POST(
      postFrom("10.0.0.8", { route: "create-offer-dialog", message: "arbitrary detailed failure text" }),
    )
    expect(res.status).toBe(200)
    expect(reportSystemErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "arbitrary detailed failure text" }),
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
