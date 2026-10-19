import { describe, it, expect, vi, beforeEach } from "vitest"

let inserted: Record<string, unknown> | null = null
let existing: { id: string } | null = null
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ like: () => ({ is: () => ({ limit: () => ({ maybeSingle: async () => ({ data: existing }) }) }) }) }) }),
      insert: (row: Record<string, unknown>) => { inserted = row; return { select: () => ({ single: async () => ({ data: { id: "m1" }, error: null }) }) } },
    }),
  },
}))

import { emitSecondInstallmentPaidEvent } from "@/lib/portal/chat-events"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { suggestedStepFor } from "@/lib/notifications/whats-new-defaults"

beforeEach(() => { inserted = null; existing = null })

describe("2nd installment paid → ONE staff-only What's New note (replaces the retired accountant email)", () => {
  it("posts a system note on the company, once per company+year", async () => {
    const r = await emitSecondInstallmentPaidEvent({ accountId: "acc", companyName: "Acme LLC", year: 2026 })
    expect(r.emitted).toBe(true)
    expect(inserted).toMatchObject({ account_id: "acc", contact_id: null, sender_type: "system" })
    const msg = String(inserted?.message)
    expect(msg).toContain("2nd installment 2026 paid — the tax return gate is lifted for Acme LLC.")
    expect(msg).not.toMatch(/accountant|india/i)
    expect(msg).toContain("kind=installment_2_paid src=accounts:acc:installment_2:2026")
  })
  it("a repeat (reversed and re-matched payment) posts nothing", async () => {
    existing = { id: "old" }
    const r = await emitSecondInstallmentPaidEvent({ accountId: "acc", companyName: "Acme LLC", year: 2026 })
    expect(r).toMatchObject({ emitted: false, reason: "already_emitted" })
    expect(inserted).toBeNull()
  })
  it("has a label and a default next step in the Calendar", () => {
    const panel = readFileSync(join(__dirname, "..", "..", "components/portal-chats/thread-whats-new-panel.tsx"), "utf8")
    expect(panel).toMatch(/installment_2_paid: '[^']+'/)
    expect(suggestedStepFor("installment_2_paid")).toMatch(/gate is lifted/i)
    expect(suggestedStepFor("installment_2_paid")).not.toMatch(/accountant|india/i)
  })
})
