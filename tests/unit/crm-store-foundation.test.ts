import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { isStoreStaffRole, isStoreStaffUser } from "@/lib/crm-store/access"
import { storeNameKey, storeRoleKey } from "@/lib/crm-store/rules"
import { CLIENT_SAFE_FLOW_DOC_STAGES } from "@/lib/flows/flow-doc-visibility"

const MIGRATION = readFileSync(
  join(process.cwd(), "scripts/migrations/20260924-2300-crm-store-foundation-s1.sql"),
  "utf8",
)

describe("store access allow-list", () => {
  it("allows admin and team, case/space-insensitive", () => {
    expect(isStoreStaffRole("admin")).toBe(true)
    expect(isStoreStaffRole(" Team ")).toBe(true)
  })
  it("refuses client, partner, empty, missing and unknown roles (unlike the app-wide blocklist)", () => {
    for (const r of ["client", "partner", "", "manager", null, undefined, 42]) {
      expect(isStoreStaffRole(r)).toBe(false)
    }
  })
  it("reads app_metadata only, never user_metadata", () => {
    expect(isStoreStaffUser({ app_metadata: { role: "admin" } } as never)).toBe(true)
    expect(isStoreStaffUser({ app_metadata: {}, user_metadata: { role: "admin" } } as never)).toBe(false)
    expect(isStoreStaffUser(null)).toBe(false)
  })
})

describe("name and role keys", () => {
  it("normalises names like the SQL store_name_key", () => {
    expect(storeNameKey("  Passport.PDF ")).toBe("passport.pdf")
    // NFD "é" and NFC "é" collide
    expect(storeNameKey("Café")).toBe(storeNameKey("Café"))
  })
  it("normalises roles like the SQL store_role_key", () => {
    expect(storeRoleKey("  Sole  Member ")).toBe("sole member")
    expect(storeRoleKey("authorized_representative")).toBe("authorized representative")
    expect(storeRoleKey("Authorized Representative")).toBe("authorized representative")
    expect(storeRoleKey(null)).toBe("")
  })
})

describe("S1 migration invariants (static)", () => {
  it("never cascades a delete", () => {
    expect(MIGRATION).not.toMatch(/ON DELETE CASCADE/i)
  })
  it("gives every store table RLS with no permissive policy", () => {
    expect(MIGRATION).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(MIGRATION).not.toMatch(/CREATE POLICY/i)
  })
  it("does not add a competing members end column (reuses members.end_date, job f4c5c023)", () => {
    expect(MIGRATION).not.toMatch(/ALTER TABLE public\.members/i)
  })
  it("seeds the explicit personal list incl. 1040-NR, and not the SS-4 or BOI report", () => {
    const m = MIGRATION.match(/v_personal\s+text\[\] := ARRAY\[([^\]]+)\]/)
    expect(m).toBeTruthy()
    const list = m![1]
    for (const t of ["Passport", "ID Document", "ITIN Letter", "Form W-7", "Form 1040-NR"]) expect(list).toContain(`'${t}'`)
    for (const t of ["Form SS-4", "BOI Report", "Tax Return", "Form 1065"]) expect(list).not.toContain(`'${t}'`)
  })
  it("client-safe stages in the catalog match today's code, plus the signed SS-4 (Antonio #43)", () => {
    for (const [serviceType, stages] of Object.entries(CLIENT_SAFE_FLOW_DOC_STAGES)) {
      const row = MIGRATION.match(new RegExp(`"service_type":"${serviceType}","stages":\\[([^\\]]*)\\]`))
      expect(row, serviceType).toBeTruthy()
      const seeded = JSON.parse(`[${row![1]}]`) as string[]
      const expected = serviceType === "Company Formation" ? [...Array.from(stages), "Signed"] : Array.from(stages)
      expect(seeded.sort()).toEqual(expected.sort())
    }
  })
})
