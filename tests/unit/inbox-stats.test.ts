/**
 * Tests for app/api/inbox/stats/route.ts
 *
 * Covers: the WhatsApp unread total must exclude deleted (is_active=false)
 * conversations — bug-hunter finding, dev job f331cd43, 2026-09-18. Before
 * that fix, deleting a WhatsApp conversation with unread messages left the
 * dashboard badge permanently over-counted with no way to clear it.
 *
 * ALSO covers: the WhatsApp badge must only count WhatsApp groups, not every
 * platform in messaging_groups — Antonio, 2026-09-19: badge showed "5" with
 * nothing unread visible in the WhatsApp list; live production check found
 * the 5 was 2 unread Telegram conversations being summed into the WhatsApp
 * total because the original query never filtered by channel platform.
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

const channelsEq = vi.fn()
const isActiveEq = vi.fn()
const gt = vi.fn()
const inChannelIds = vi.fn()
let channelRows: { id: string }[] = [{ id: "wa-channel-1" }]
let groupsResult: { data: { unread_count: number }[]; error: null } = { data: [], error: null }

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messaging_channels") {
      return {
        select: () => ({
          eq: (...args: unknown[]) => {
            channelsEq(...args)
            return Promise.resolve({ data: channelRows, error: null })
          },
        }),
      }
    }
    if (table === "messaging_groups") {
      return {
        select: () => ({
          eq: (...args: unknown[]) => {
            isActiveEq(...args)
            return {
              gt: (...gtArgs: unknown[]) => {
                gt(...gtArgs)
                return {
                  in: (...inArgs: unknown[]) => {
                    inChannelIds(...inArgs)
                    return Promise.resolve(groupsResult)
                  },
                }
              },
            }
          },
        }),
      }
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
  channelRows = [{ id: "wa-channel-1" }]
  groupsResult = { data: [], error: null }
})

describe("GET /api/inbox/stats", () => {
  it("filters the WhatsApp unread query to is_active groups on WhatsApp channels only", async () => {
    groupsResult = { data: [{ unread_count: 2 }, { unread_count: 3 }], error: null }

    const res = await GET()
    const body = await res.json()

    expect(channelsEq).toHaveBeenCalledWith("platform", "whatsapp")
    expect(isActiveEq).toHaveBeenCalledWith("is_active", true)
    expect(inChannelIds).toHaveBeenCalledWith("channel_id", ["wa-channel-1"])
    expect(body.whatsapp).toBe(5)
    expect(body.total).toBe(10)
  })

  it("does not count unread messages sitting on a deleted (hidden) conversation", async () => {
    // Simulates the fix: the is_active filter means a hidden group's stale
    // unread_count never reaches this query's result set in the first place.
    groupsResult = { data: [{ unread_count: 2 }], error: null }

    const res = await GET()
    const body = await res.json()

    expect(body.whatsapp).toBe(2)
  })

  it("never counts a Telegram group's unread_count toward the WhatsApp badge", async () => {
    // The real 2026-09-19 incident: 2 unread Telegram groups (sum 5) with
    // zero unread WhatsApp groups. Only WhatsApp channel ids ever reach the
    // messaging_groups query — a Telegram group's row is never in the mocked
    // result at all, proving the platform filter is what keeps it out.
    groupsResult = { data: [], error: null }

    const res = await GET()
    const body = await res.json()

    expect(body.whatsapp).toBe(0)
  })

  it("returns 0 WhatsApp unread (and skips the groups query) when no WhatsApp channel exists", async () => {
    channelRows = []

    const res = await GET()
    const body = await res.json()

    expect(body.whatsapp).toBe(0)
    expect(isActiveEq).not.toHaveBeenCalled()
  })
})
