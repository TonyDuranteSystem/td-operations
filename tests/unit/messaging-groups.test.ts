/**
 * Tests for lib/messaging/groups.ts — findOrCreateWhatsAppGroup.
 *
 * Covers the exact defect this helper was written to close: two different
 * external_group_id conventions for the same real number must resolve to
 * ONE group, keyed on the canonical JID regardless of input format.
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
import { findOrCreateWhatsAppGroup } from "@/lib/messaging/groups"

function mockLookup(row: unknown, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error })
  const eq2 = vi.fn(() => ({ maybeSingle }))
  const eq1 = vi.fn(() => ({ eq: eq2 }))
  const select = vi.fn(() => ({ eq: eq1 }))
  const single = vi.fn()
  const upsertSelect = vi.fn(() => ({ single }))
  const upsert = vi.fn(() => ({ select: upsertSelect }))
  ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, upsert })
  return { single, upsert }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("findOrCreateWhatsAppGroup", () => {
  it("finds an existing group keyed on the canonical JID, regardless of input format", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "17274521093@c.us", group_name: "Someone" }
    mockLookup(existing)

    const result = await findOrCreateWhatsAppGroup({
      channelId: "ch1",
      remoteIdentifier: "+1 (727) 452-1093",
    })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof existing }).group).toEqual(existing)
  })

  it("creates a new group via upsert when none exists, keyed on the canonical JID", async () => {
    const { single, upsert } = mockLookup(null)
    const created = { id: "g2", channel_id: "ch1", external_group_id: "17274521093@c.us", group_name: "New Lead" }
    single.mockResolvedValue({ data: created, error: null })

    const result = await findOrCreateWhatsAppGroup({
      channelId: "ch1",
      remoteIdentifier: "17274521093",
      groupName: "New Lead",
    })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof created }).group).toEqual(created)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "ch1", external_group_id: "17274521093@c.us" }),
      { onConflict: "channel_id,external_group_id" }
    )
  })

  it("returns an error, not a throw, when the lookup fails", async () => {
    mockLookup(null, { message: "db down" })
    const result = await findOrCreateWhatsAppGroup({ channelId: "ch1", remoteIdentifier: "17274521093" })
    expect("error" in result).toBe(true)
    expect((result as { error: string }).error).toContain("db down")
  })

  it("returns an error, not a throw, when the upsert fails", async () => {
    const { single } = mockLookup(null)
    single.mockResolvedValue({ data: null, error: { message: "constraint violation" } })
    const result = await findOrCreateWhatsAppGroup({ channelId: "ch1", remoteIdentifier: "17274521093" })
    expect("error" in result).toBe(true)
    expect((result as { error: string }).error).toContain("constraint violation")
  })

  it("patches contact_id onto an existing group that only has a stale lead_id (lead-converts-to-contact case)", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "17274521093@c.us", group_name: "Jane", account_id: null, contact_id: null, lead_id: "lead-1" }
    const patched = { ...existing, contact_id: "contact-1" }
    const updateSingle = vi.fn().mockResolvedValue({ data: patched, error: null })
    const updateSelect = vi.fn(() => ({ single: updateSingle }))
    const updateEq = vi.fn(() => ({ select: updateSelect }))
    const update = vi.fn(() => ({ eq: updateEq }))
    const maybeSingle = vi.fn().mockResolvedValue({ data: existing, error: null })
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, update })

    const result = await findOrCreateWhatsAppGroup({
      channelId: "ch1",
      remoteIdentifier: "17274521093",
      contactId: "contact-1",
    })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof patched }).group.contact_id).toBe("contact-1")
    expect((result as { group: typeof patched }).group.lead_id).toBe("lead-1")
    expect(update).toHaveBeenCalledWith({ contact_id: "contact-1" })
  })

  it("never overwrites an already-set contact_id with a different one", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "17274521093@c.us", group_name: "Jane", account_id: null, contact_id: "contact-original", lead_id: null }
    mockLookup(existing)

    const result = await findOrCreateWhatsAppGroup({
      channelId: "ch1",
      remoteIdentifier: "17274521093",
      contactId: "contact-different",
    })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof existing }).group.contact_id).toBe("contact-original")
  })

  it("falls back to the original row if the identity patch itself fails, rather than erroring the send", async () => {
    const existing = { id: "g1", channel_id: "ch1", external_group_id: "17274521093@c.us", group_name: "Jane", account_id: null, contact_id: null, lead_id: null }
    const updateSingle = vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } })
    const updateSelect = vi.fn(() => ({ single: updateSingle }))
    const updateEq = vi.fn(() => ({ select: updateSelect }))
    const update = vi.fn(() => ({ eq: updateEq }))
    const maybeSingle = vi.fn().mockResolvedValue({ data: existing, error: null })
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, update })

    const result = await findOrCreateWhatsAppGroup({
      channelId: "ch1",
      remoteIdentifier: "17274521093",
      contactId: "contact-1",
    })

    expect("group" in result).toBe(true)
    expect((result as { group: typeof existing }).group).toEqual(existing)
  })

  it("reuses a LEGACY bare-digit chat when the canonical key has none — no second thread (bridge cutover)", async () => {
    const legacy = { id: "old1", channel_id: "ch1", external_group_id: "17274521093", group_name: "Old import" }
    const maybeSingle = vi.fn().mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: legacy, error: null })
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    const upsert = vi.fn()
    ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, upsert })

    const result = await findOrCreateWhatsAppGroup({ channelId: "ch1", remoteIdentifier: "+1 (727) 452-1093" })

    expect((result as { group: typeof legacy }).group).toEqual(legacy)
    expect(upsert).not.toHaveBeenCalled() // nothing created
    // canonical lookup first, then the bare-digit key
    expect(eq2).toHaveBeenNthCalledWith(1, "external_group_id", "17274521093@c.us")
    expect(eq2).toHaveBeenNthCalledWith(2, "external_group_id", "17274521093")
  })

  it("the canonical chat wins when BOTH keys exist (an already-split thread is not made worse)", async () => {
    const canonical = { id: "new1", channel_id: "ch1", external_group_id: "17274521093@c.us", group_name: "Canon" }
    const maybeSingle = vi.fn().mockResolvedValueOnce({ data: canonical, error: null })
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, upsert: vi.fn() })

    const result = await findOrCreateWhatsAppGroup({ channelId: "ch1", remoteIdentifier: "17274521093" })
    expect((result as { group: typeof canonical }).group).toEqual(canonical)
    expect(maybeSingle).toHaveBeenCalledTimes(1) // no second lookup needed
  })

  it("returns an error when the LEGACY-key lookup fails (never falls through to create a duplicate)", async () => {
    const maybeSingle = vi.fn().mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { message: "legacy lookup down" } })
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    const upsert = vi.fn()
    ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select, upsert })

    const result = await findOrCreateWhatsAppGroup({ channelId: "ch1", remoteIdentifier: "17274521093" })
    expect((result as { error: string }).error).toContain("legacy lookup down")
    expect(upsert).not.toHaveBeenCalled()
  })
})
