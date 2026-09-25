import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { isStoreStaffRole, isStoreStaffUser } from "@/lib/crm-store/access"
import {
  storeNameKey,
  storeRoleKey,
  resolveContactRole,
  resolveLifecycle,
  isClientVisible,
  isPersonalFile,
  type ContactRoleEntry,
  type LifecycleMapEntry,
  type DocumentTypeEntry,
  type ClientSafeStagesEntry,
} from "@/lib/crm-store/rules"
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

const ROLES: ContactRoleEntry[] = [
  { slug: "owner", matches: ["owner", "sole member"], appears_in_contacts: true, portal_audience: true },
  { slug: "member", matches: ["member"], appears_in_contacts: true, portal_audience: true },
  { slug: "representative", matches: ["authorized representative"], appears_in_contacts: false, portal_audience: true },
]

describe("resolveContactRole", () => {
  it("maps today's free-text variants", () => {
    expect(resolveContactRole("Owner", ROLES, false)).toBe("owner")
    expect(resolveContactRole("owner", ROLES, false)).toBe("owner")
    expect(resolveContactRole("Sole Member", ROLES, false)).toBe("owner")
    expect(resolveContactRole("Member", ROLES, false)).toBe("member")
    expect(resolveContactRole("authorized_representative", ROLES, false)).toBe("representative")
  })
  it("treats a role-less single link as the owner (single-member LLC), but not when there are several links", () => {
    expect(resolveContactRole(null, ROLES, true)).toBe("owner")
    expect(resolveContactRole("", ROLES, false)).toBeNull()
  })
  it("returns null for roles nobody mapped (reported, never silently dropped)", () => {
    expect(resolveContactRole("Partner - Tax/NHR Consultant (Portugal)", ROLES, false)).toBeNull()
  })
})

const MAP: LifecycleMapEntry[] = [
  { account_status: "Active", lifecycle: "active", portal_visible: true },
  { account_status: "Suspended", lifecycle: "active", portal_visible: true },
  { account_status: "Closed", lifecycle: "archived", portal_visible: false },
]

describe("resolveLifecycle", () => {
  it("reads active/archived from the CRM status (never stored)", () => {
    expect(resolveLifecycle(null, "Active", MAP)).toEqual({ lifecycle: "active", portalVisible: true })
    expect(resolveLifecycle(null, "Suspended", MAP)).toEqual({ lifecycle: "active", portalVisible: true })
    expect(resolveLifecycle(null, "Closed", MAP)).toEqual({ lifecycle: "archived", portalVisible: false })
  })
  it("storage-only overlays win", () => {
    expect(resolveLifecycle("in_formation", null, MAP).lifecycle).toBe("in_formation")
    expect(resolveLifecycle("archived", "Active", MAP).lifecycle).toBe("archived")
    expect(resolveLifecycle("in_onboarding", "Active", MAP).lifecycle).toBe("in_onboarding")
  })
  it("fails closed on an unknown status", () => {
    expect(resolveLifecycle(null, "Weird", MAP)).toEqual({ lifecycle: "archived", portalVisible: false })
  })
})

const TYPES: DocumentTypeEntry[] = [
  { slug: "tax_return", personal: false, draft_never_visible: true },
  { slug: "passport", personal: true, draft_never_visible: false },
  { slug: "form_ss_4", personal: false, draft_never_visible: false },
]
const SAFE: ClientSafeStagesEntry[] = [
  { service_type: "Tax Return", stages: ["Signed", "Completed"] },
  { service_type: "Company Formation", stages: ["Articles Received", "Signed"] },
]

describe("isClientVisible", () => {
  const base = { published: false, filingStatus: "none" as const, documentType: null, serviceType: null, stageAtCreation: null }
  it("published files are visible", () => {
    expect(isClientVisible({ ...base, published: true }, TYPES, SAFE)).toBe(true)
  })
  it("files created in a client-safe stage are visible; other stages are not", () => {
    expect(isClientVisible({ ...base, serviceType: "Tax Return", stageAtCreation: "Signed" }, TYPES, SAFE)).toBe(true)
    expect(isClientVisible({ ...base, serviceType: "Tax Return", stageAtCreation: "Tax Return Prepared" }, TYPES, SAFE)).toBe(false)
  })
  it("the unsigned prepared return is never visible while draft, even if published", () => {
    expect(isClientVisible({ ...base, published: true, documentType: "tax_return", filingStatus: "draft" }, TYPES, SAFE)).toBe(false)
  })
  it("fails closed with no link", () => {
    expect(isClientVisible(base, TYPES, SAFE)).toBe(false)
  })
})

describe("isPersonalFile", () => {
  it("person-owned files and personal types are private; SS-4 and tax returns are company documents", () => {
    expect(isPersonalFile("person", null, TYPES)).toBe(true)
    expect(isPersonalFile("company", "passport", TYPES)).toBe(true)
    expect(isPersonalFile("company", "form_ss_4", TYPES)).toBe(false)
    expect(isPersonalFile("company", "tax_return", TYPES)).toBe(false)
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
