import { describe, it, expect, vi, beforeEach } from "vitest"

let pilot = false
let kind: string | null = "business"
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u" } } }) } }) }))
vi.mock("@/lib/crm-store/access", () => ({ isStoreStaffUser: () => true }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ pilotEnvironmentAllowed: () => pilot }))
vi.mock("@/lib/crm-store/drive-import", () => ({ studyCopyAllowed: () => false }))
vi.mock("@/lib/crm-store/structure", () => ({ ownerOfFolder: async () => "o1", ownerOfFile: async () => "o1" }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: kind ? { kind } : null }) }) }) }) },
}))

import { denyUnlessStorePilotEnv } from "@/app/api/crm-store/browse/_auth"

describe("denyUnlessStorePilotEnv — the firm's own areas", () => {
  beforeEach(() => { pilot = false; kind = "business" })
  it("allows a business or private folder outside the pilot", async () => {
    expect(await denyUnlessStorePilotEnv({ folderId: "f1" })).toBeNull()
    kind = "private"
    expect(await denyUnlessStorePilotEnv({ ownerId: "o1" })).toBeNull()
  })
  it("still refuses a client company outside the pilot", async () => {
    kind = "company"
    expect((await denyUnlessStorePilotEnv({ folderId: "f1" }))?.status).toBe(403)
  })
  it("refuses when no reference is given or the owner is unknown", async () => {
    expect((await denyUnlessStorePilotEnv({}))?.status).toBe(403)
    kind = null
    expect((await denyUnlessStorePilotEnv({ fileId: "x" }))?.status).toBe(403)
  })
  it("allows anything in the pilot environment", async () => {
    pilot = true; kind = "company"
    expect(await denyUnlessStorePilotEnv({ folderId: "f1" })).toBeNull()
  })
})
