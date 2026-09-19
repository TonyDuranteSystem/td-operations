/**
 * Tests for app/api/inbox/stats/route.ts
 *
 * Covers: the WhatsApp unread total must exclude deleted (is_active=false)
 * conversations — bug-hunter finding, dev job f331cd43, 2026-09-18. Before
 * that fix, deleting a WhatsApp conversation with unread messages left the
 * dashboard badge permanently over-counted with no way to clear it.
 *
 * ALSO covers: each platform's badge must only count that platform's groups,
 * not every platform in messaging_groups — Antonio, 2026-09-19: the WhatsApp
 * badge showed "5" with nothing unread visible in the WhatsApp list; live
 * production check found the 5 was 2 unread Telegram conversations being
 * summed into the WhatsApp total because the original query never filtered
 * by channel platform. The route was refactored into a per-platform helper
 * (`unreadCountForPlatform`) reused for both WhatsApp and Telegram so a third
 * channel can't repeat the same mistake.
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

/** channelRows/groupsResult keyed by platform, so whatsapp and telegram can be
 *  configured independently per test. */
let channelRowsByPlatform: Record<string, { id: string }[]> = {}
let groupsResultByPlatform: Record<string, { data: { unread_count: number }[]; error: null }> = {}

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messaging_channels") {
      return {
        select: () => ({
          eq: (_col: string, platform: string) => {
            channelsEq(platform)
            return Promise.resolve({ data: channelRowsByPlatform[platform] ?? [], error: null })
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
                  in: (_col: string, channelIds: string[]) => {
                    inChannelIds(channelIds)
                    // Recover which platform this call is for from the ids
                    // passed to it — this mock resolves that from the fixture
                    // that produced those ids in the FIRST place.
                    const platform = Object.keys(channelRowsByPlatform).find(
                      (p) => JSON.stringify(channelRowsByPlatform[p]?.map((c) => c.id)) === JSON.stringify(channelIds)
                    )
                    return Promise.resolve(
                      (platform && groupsResultByPlatform[platform]) ?? { data: [], error: null }
                    )
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
  channelRowsByPlatform = { whatsapp: [{ id: "wa-channel-1" }], telegram: [{ id: "tg-channel-1" }] }
  groupsResultByPlatform = {}
})

describe("GET /api/inbox/stats", () => {
  it("filters the WhatsApp unread query to is_active groups on WhatsApp channels only", async () => {
    groupsResultByPlatform = { whatsapp: { data: [{ unread_count: 2 }, { unread_count: 3 }], error: null } }

    const res = await GET()
    const body = await res.json()

    expect(channelsEq).toHaveBeenCalledWith("whatsapp")
    expect(isActiveEq).toHaveBeenCalledWith("is_active", true)
    expect(inChannelIds).toHaveBeenCalledWith(["wa-channel-1"])
    expect(body.whatsapp).toBe(5)
    expect(body.total).toBe(10)
  })

  it("does not count unread messages sitting on a deleted (hidden) conversation", async () => {
    // Simulates the fix: the is_active filter means a hidden group's stale
    // unread_count never reaches this query's result set in the first place.
    groupsResultByPlatform = { whatsapp: { data: [{ unread_count: 2 }], error: null } }

    const res = await GET()
    const body = await res.json()

    expect(body.whatsapp).toBe(2)
  })

  it("never counts a Telegram group's unread_count toward the WhatsApp badge, and reports it under telegram instead", async () => {
    // The real 2026-09-19 incident: 2 unread Telegram groups (sum 5) with
    // zero unread WhatsApp groups. Each platform is resolved via its OWN
    // channel ids, so a Telegram group's row is never reachable from the
    // WhatsApp query at all.
    groupsResultByPlatform = {
      whatsapp: { data: [], error: null },
      telegram: { data: [{ unread_count: 2 }, { unread_count: 3 }], error: null },
    }

    const res = await GET()
    const body = await res.json()

    expect(body.whatsapp).toBe(0)
    expect(body.telegram).toBe(5)
    expect(body.total).toBe(10)
  })

  it("returns 0 unread (and skips the groups query) for a platform with no channel configured", async () => {
    channelRowsByPlatform = { whatsapp: [{ id: "wa-channel-1" }], telegram: [] }
    groupsResultByPlatform = { whatsapp: { data: [], error: null } }

    const res = await GET()
    const body = await res.json()

    expect(body.telegram).toBe(0)
    // Only one platform's groups query should have run (whatsapp's) — telegram
    // had no channel ids, so it short-circuits before ever calling .eq('is_active', ...).
    expect(isActiveEq).toHaveBeenCalledTimes(1)
  })
})
