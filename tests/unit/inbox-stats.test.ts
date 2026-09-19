/**
 * Tests for app/api/inbox/stats/route.ts
 *
 * Covers: the WhatsApp unread total must exclude deleted (is_active=false)
 * conversations — bug-hunter finding, dev job f331cd43, 2026-09-18. Before
 * the fix, deleting a WhatsApp conversation with unread messages left the
 * dashboard badge permanently over-counted with no way to clear it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const requireStaffRoute = vi.fn()
vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: () => requireStaffRoute(),
}))

const gmailGet = vi.fn()
vi.mock("@/lib/gmail", () => ({
  gmailGet: (...args: unknown[]) => gmailGet(...args),
}))

const isActiveEq = vi.fn()
const gt = vi.fn()
vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messaging_groups") {
      return { select: () => ({ eq: (...args: unknown[]) => { isActiveEq(...args); return { gt } } }) }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { supabaseAdmin: { from } }
})

import { GET } from "@/app/api/inbox/stats/route"

beforeEach(() => {
  vi.clearAllMocks()
  requireStaffRoute.mockResolvedValue(null)
  gmailGet.mockResolvedValue({ messagesUnread: 5 })
})

describe("GET /api/inbox/stats", () => {
  it("filters the WhatsApp unread query to is_active groups only", async () => {
    gt.mockResolvedValue({ data: [{ unread_count: 2 }, { unread_count: 3 }], error: null })

    const res = await GET()
    const body = await res.json()

    expect(isActiveEq).toHaveBeenCalledWith("is_active", true)
    expect(body.whatsapp).toBe(5)
    expect(body.total).toBe(10)
  })

  it("does not count unread messages sitting on a deleted (hidden) conversation", async () => {
    // Simulates the fix: the is_active filter means a hidden group's stale
    // unread_count never reaches this query's result set in the first place.
    gt.mockResolvedValue({ data: [{ unread_count: 2 }], error: null })

    const res = await GET()
    const body = await res.json()

    expect(body.whatsapp).toBe(2)
  })
})
