import { describe, it, expect, vi, beforeEach } from "vitest"

const result = { data: null as unknown, error: null as unknown }
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) },
}))

import { resolveOaManagerName } from "@/lib/oa/resolve-manager"

beforeEach(() => { result.data = null; result.error = null })

describe("resolveOaManagerName (database)", () => {
  it("uses the company's manager for a multi-member company", async () => {
    result.data = { manager_name: "Antonio Durante", entity_type: "Multi Member LLC", member_structure: "multi_member" }
    expect(await resolveOaManagerName("acc", "Giulia")).toBe("Antonio Durante")
  })
  it("ignores the manager box for a single-member company", async () => {
    result.data = { manager_name: "Antonio Durante", entity_type: "Single Member LLC", member_structure: "single_member" }
    expect(await resolveOaManagerName("acc", "Giulia")).toBe("Giulia")
  })
  it("falls back to the signer when the box is blank", async () => {
    result.data = { manager_name: null, entity_type: "Multi Member LLC", member_structure: "multi_member" }
    expect(await resolveOaManagerName("acc", "Giulia")).toBe("Giulia")
  })
  it("fails closed when the read fails", async () => {
    result.error = { message: "timeout" }
    await expect(resolveOaManagerName("acc", "Giulia")).rejects.toThrow(/timeout/)
  })
  it("returns the signer when there is no account id", async () => {
    expect(await resolveOaManagerName(null, "Giulia")).toBe("Giulia")
  })
})
