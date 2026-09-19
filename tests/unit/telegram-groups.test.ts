/**
 * Tests for lib/messaging/telegram-groups.ts — findOrCreateTelegramGroup.
 *
 * Telegram's counterpart to groups.ts::findOrCreateWhatsAppGroup, but with no
 * identifier normalization: chat.id is already a stable key, used verbatim.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase-admin", () => {
  const maybeSingle = vi.fn()
  const eq2 = vi.fn(() => ({ maybeSingle }))
  const eq1 = vi.fn(() => ({ eq: eq2 }))
  const select = vi.fn(() => ({ eq: eq1 }))
  const single = vi.fn()
  const upsertSelect = vi.fn(() => ({ single }))
  const upsert = vi.fn(() => ({ select: upsertSelect }))
  const from = vi.fn(() => ({ select, upsert }))
  return { supabaseAdmin: { from } }
})

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findOrCreateTelegramGroup } from "@/lib/messaging/telegram-groups"

function mockLookup(row: unknown, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error })
  const eq2 = vi.fn(() => ({ maybeSingle }))
  const eq1 = vi.fn(() => ({ eq: eq2 }))
  const select = vi.fn(() => ({ eq: eq1 }))
  const single = vi.fn()
  const patchSelect = vi.fn(() => ({ single }))
  const patchEq = vi.fn(() => ({ select: patchSelect }))
  const update = vi.fn(() => ({ eq: patchEq }))
  const upsertSelect = vi.fn(() => ({ single }))
  const upsert = vi.fn(() => ({ select: upsertSelect }))
  ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, update, upsert })
  return { single, upsert, update }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("findOrCreateTelegramGroup", () => {
  it("finds an existing group keyed verbatim on chat_id — no identifier transformation", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "-5366287225", group_name: "Daniel X accountant" }
    mockLookup(existing)

    const result = await findOrCreateTelegramGroup({ channelId: "ch1", chatId: "-5366287225" })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof existing }).group).toEqual(existing)
  })

  it("creates a new group via upsert when none exists", async () => {
    const { single, upsert } = mockLookup(null)
    const created = { id: "g2", channel_id: "ch1", external_group_id: "7064869750", group_name: "Midnight Pearl" }
    single.mockResolvedValue({ data: created, error: null })

    const result = await findOrCreateTelegramGroup({ channelId: "ch1", chatId: "7064869750", groupName: "Midnight Pearl" })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof created }).group).toEqual(created)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "ch1", external_group_id: "7064869750", group_name: "Midnight Pearl" }),
      { onConflict: "channel_id,external_group_id" }
    )
  })

  it("patches an existing group's blank name from the caller's fresher name", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "123", group_name: null }
    const { single } = mockLookup(existing)
    const patched = { ...existing, group_name: "New Name" }
    single.mockResolvedValue({ data: patched, error: null })

    const result = await findOrCreateTelegramGroup({ channelId: "ch1", chatId: "123", groupName: "New Name" })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof patched }).group.group_name).toBe("New Name")
  })

  it("never overwrites an already-named group with a new name", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "123", group_name: "Already Named" }
    mockLookup(existing)

    const result = await findOrCreateTelegramGroup({ channelId: "ch1", chatId: "123", groupName: "Some Other Name" })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof existing }).group).toEqual(existing)
  })

  it("returns an error when the lookup itself fails", async () => {
    mockLookup(null, { message: "connection refused" })

    const result = await findOrCreateTelegramGroup({ channelId: "ch1", chatId: "123" })

    expect("error" in result).toBe(true)
    expect((result as { error: string }).error).toContain("connection refused")
  })
})
