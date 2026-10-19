import { describe, it, expect, vi, beforeEach } from "vitest"

/** Stop-Drive S1a round 4: a member's passport is held for THEIR OWN storage — never filed under the primary contact, the owner or a company folder. */
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1, 2])], { type: "application/pdf" }), error: null }) }) } },
}))
const saved: Array<Record<string, unknown>> = []
const alarms: string[] = []
vi.mock("@/lib/crm-store/browse", () => ({ storeOwnerForAccount: async () => "company-owner" }))
vi.mock("@/lib/crm-store/formation-pilot", () => ({
  savePilotFile: vi.fn(async (p: Record<string, unknown>) => { saved.push(p); return { status: "created", fileId: "f" } }),
  ensurePersonOwner: vi.fn(async () => "owner-person"),
  raisePilotAlarm: vi.fn(async (k: string) => { alarms.push(k) }),
}))

import { heldMembersOf, heldMembersWithoutEmail, memberIndexOfUpload, fileHeldMemberPassportsForContact, type HandOffDeps } from "@/lib/crm-store/held-member-passports"
import { saveUploadsToStoreForAccount } from "@/lib/crm-store/account-uploads"

beforeEach(() => { saved.length = 0; alarms.length = 0 })

const data = { additional_members: [
  { member_first_name: "Luigi", member_last_name: "Verdi", member_email: "Luigi@Verdi.it" },
  { member_first_name: "Gina", member_last_name: "Neri" }, // no email
  { member_type: "company", member_company_name: "Acme" },
] }
const paths = ["f/passport_owner.pdf", "f/passport_member_0.pdf", "f/passport_member_1.pdf", "f/member_2_member_passport.pdf"]

describe("held member passports", () => {
  it("recognises both upload key shapes", () => {
    expect(memberIndexOfUpload("a/passport_member_3.pdf")).toBe(3)
    expect(memberIndexOfUpload("a/member_2_member_passport.png")).toBe(2)
    expect(memberIndexOfUpload("a/passport_owner.pdf")).toBeNull()
  })
  it("lists individual members with a passport waiting (a company member has none) and those without an email", () => {
    const held = heldMembersOf(data, paths)
    expect(held.map((h) => [h.index, h.name, h.email])).toEqual([[0, "Luigi Verdi", "luigi@verdi.it"], [1, "Gina Neri", null]])
    expect(heldMembersWithoutEmail(held).map((h) => h.name)).toEqual(["Gina Neri"])
  })

  const mkDeps = (over: Partial<HandOffDeps> = {}): HandOffDeps & { filed: Array<Record<string, unknown>> } => {
    const filed: Array<Record<string, unknown>> = []
    return Object.assign({
      contact: async () => ({ full_name: "Luigi Verdi", email: "LUIGI@verdi.it" }),
      recentSubmissions: async () => [{ submitted_data: data, upload_paths: paths }],
      namesMatch: (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase(),
      download: async () => ({ bytes: Buffer.from("x"), mimeType: "application/pdf" }),
      save: async (p: Record<string, unknown>) => { filed.push(p); return { status: "saved" } },
      filed,
    }, over) as never
  }
  it("when THAT member's contact appears (exact email + name), the held passport is filed in THAT member's storage — once", async () => {
    const d = mkDeps()
    expect(await fileHeldMemberPassportsForContact("c-luigi", d)).toBe(1)
    expect(d.filed).toHaveLength(1)
    expect(d.filed[0]).toMatchObject({ contactId: "c-luigi", fileName: "passport_member_0.pdf" })
  })
  it("another person with the same name but a different email gets nothing; neither does an email-less member's lookalike", async () => {
    expect(await fileHeldMemberPassportsForContact("c-x", mkDeps({ contact: async () => ({ full_name: "Luigi Verdi", email: "other@x.it" }) }))).toBe(0)
    expect(await fileHeldMemberPassportsForContact("c-y", mkDeps({ contact: async () => ({ full_name: "Gina Neri", email: "gina@x.it" }) }))).toBe(0) // Gina had no email on the form: staff decide
    expect(await fileHeldMemberPassportsForContact("c-z", mkDeps({ contact: async () => ({ full_name: "Maria Verdi", email: "luigi@verdi.it" }) }))).toBe(0) // same email, different name
  })
  it("never throws and files nothing when anything fails", async () => {
    expect(await fileHeldMemberPassportsForContact("c", mkDeps({ recentSubmissions: async () => { throw new Error("db down") } }))).toBe(0)
    expect(await fileHeldMemberPassportsForContact("c", mkDeps({ download: async () => null }))).toBe(0)
  })
})

describe("saveUploadsToStoreForAccount — member passports are held, the owner's goes to the owner", () => {
  it("a member passport is neither filed in the company's folders nor in the owner's storage", async () => {
    const r = await saveUploadsToStoreForAccount({ accountId: "acc", flow: "onboarding", paths: ["f/passport_owner.pdf", "f/passport_member_0.pdf", "f/ein_letter.pdf"], passportContact: { contactId: "owner", name: "Owner" } })
    expect(r.held).toBe(1)
    const byName = Object.fromEntries(saved.map((s) => [s.name as string, s]))
    expect(Object.keys(byName).sort()).toEqual(["ein_letter.pdf", "passport_owner.pdf"])
    expect(byName["passport_owner.pdf"]).toMatchObject({ ownerId: "owner-person", folderKind: "personal", documentType: "passport" })
    expect(byName["ein_letter.pdf"]).toMatchObject({ ownerId: "company-owner", folderKind: "company" })
  })
})
