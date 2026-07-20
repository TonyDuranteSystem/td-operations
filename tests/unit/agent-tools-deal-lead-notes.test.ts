/**
 * update_deal_notes / update_lead_notes (lib/ai-agent/tools.ts) — mirrors the
 * existing append-with-timestamp shape used by update_account_notes/update_contact.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  existingNotes: {} as Record<string, string | null>,
  updates: [] as Array<{ table: string; row: Record<string, unknown>; id: string }>,
}))

vi.mock("@/lib/supabase-admin", () => {
  const makeChain = (table: string) => ({
    select: () => ({
      eq: (_col: string, id: string) => ({
        single: async () => ({ data: { notes: h.existingNotes[id] ?? null }, error: null }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (row: Record<string, unknown>) => ({
      eq: async (_col: string, id: string) => {
        h.updates.push({ table, row, id })
        return { data: null, error: null }
      },
    }),
  })
  return {
    supabaseAdmin: {
      from: (table: string) => makeChain(table),
    },
  }
})

import { executeTool } from "@/lib/ai-agent/tools"

beforeEach(() => {
  h.existingNotes = {}
  h.updates.length = 0
})

describe("update_deal_notes", () => {
  it("timestamps a fresh note when the deal has none yet", async () => {
    await executeTool("update_deal_notes", { deal_id: "deal-1", note: "Called client" })
    const row = h.updates.find((u) => u.table === "deals" && u.id === "deal-1")
    expect(row).toBeDefined()
    expect(row!.row.notes).toMatch(/^\d{4}-\d{2}-\d{2}: Called client$/)
  })

  it("appends to existing notes rather than overwriting them", async () => {
    h.existingNotes["deal-1"] = "2026-01-01: First note"
    await executeTool("update_deal_notes", { deal_id: "deal-1", note: "Second note" })
    const row = h.updates.find((u) => u.table === "deals" && u.id === "deal-1")
    expect(row!.row.notes).toContain("2026-01-01: First note\n")
    expect(row!.row.notes).toMatch(/Second note$/)
  })
})

describe("update_lead_notes", () => {
  it("writes to the general leads.notes column, timestamped", async () => {
    await executeTool("update_lead_notes", { lead_id: "lead-1", note: "Follow up next week" })
    const row = h.updates.find((u) => u.table === "leads" && u.id === "lead-1")
    expect(row).toBeDefined()
    expect(row!.row.notes).toMatch(/^\d{4}-\d{2}-\d{2}: Follow up next week$/)
    // Must never touch the specialized call_notes/offer_notes columns.
    expect(row!.row).not.toHaveProperty("call_notes")
    expect(row!.row).not.toHaveProperty("offer_notes")
  })

  it("appends to existing notes rather than overwriting them", async () => {
    h.existingNotes["lead-1"] = "2026-01-01: First note"
    await executeTool("update_lead_notes", { lead_id: "lead-1", note: "Second note" })
    const row = h.updates.find((u) => u.table === "leads" && u.id === "lead-1")
    expect(row!.row.notes).toContain("2026-01-01: First note\n")
    expect(row!.row.notes).toMatch(/Second note$/)
  })
})
