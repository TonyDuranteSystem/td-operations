import { describe, it, expect, vi, beforeEach } from "vitest"

// A team member (not an owner) adds a document type: allowed inside a LIVE storage, refused with no storage named or in a study copy.
let studyCopy = true
let live = true
let added: unknown = null
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "luca" } } }) } }) }))
vi.mock("@/lib/crm-store/access", () => ({ isStoreStaffUser: () => true }))
vi.mock("@/lib/auth", () => ({ isOwnerOnly: () => false }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({ pilotEnvironmentAllowed: () => false }))
vi.mock("@/lib/crm-store/drive-import", () => ({ studyCopyAllowed: () => studyCopy }))
vi.mock("@/lib/crm-store/structure", () => ({ ownerOfFolder: async () => "o1", ownerOfFile: async () => "o1" }))
vi.mock("@/lib/crm-store/plain-drop", () => ({ isInternalOwnerKind: () => false }))
vi.mock("@/lib/crm-store/custom-types", () => ({ addCustomDocumentType: async (a: unknown) => { added = a; return { slug: "x", name: "X", created: true } } }))
vi.mock("@/lib/crm-store/browse", () => ({ listDocumentTypes: async () => [] }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { kind: "company", study_only: !live } }) }) }) }) },
}))

import { POST } from "@/app/api/crm-store/browse/types/route"

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x/api/crm-store/browse/types", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never)

describe("POST /api/crm-store/browse/types — a team member adds a type", () => {
  beforeEach(() => { studyCopy = true; live = true; added = null })
  it("works inside a live storage (the folder is named)", async () => {
    const r = await post({ name: "Tax Return Draft", folderKind: "tax", folderId: "f1" })
    expect(r.status).toBe(200)
    expect(added).toMatchObject({ name: "Tax Return Draft", folderKind: "tax" })
  })
  it("is refused when no storage is named (owners only while study copies exist)", async () => {
    const r = await post({ name: "Tax Return Draft", folderKind: "tax" })
    expect(r.status).toBe(403)
    expect(added).toBeNull()
  })
  it("is refused inside a study copy", async () => {
    live = false
    const r = await post({ name: "Tax Return Draft", folderKind: "tax", folderId: "f1" })
    expect(r.status).toBe(403)
    expect(added).toBeNull()
  })
})
