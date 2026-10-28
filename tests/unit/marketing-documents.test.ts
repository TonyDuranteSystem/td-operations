import { describe, expect, it } from "vitest"
import { DOC_MAX_BYTES, DOCS_STAGING_PREFIX, canManageDocuments, canReadDocuments, docRefusal, formatDocSize, isOwnStagingPath, safeObjectName, stagingPathFor } from "@/lib/marketing/documents-rules"
import { effectivePermissions, MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"
import { modulesFor } from "@/lib/marketing/workspace"

const OWNER = "11111111-1111-4111-8111-111111111111"

describe("Documents — file checks", () => {
  it("accepts an ordinary document", () => { expect(docRefusal("Company overview.docx", 20_000)).toBeNull() })
  it("refuses programs and scripts, empty files, bad names and files over the limit — in plain words", () => {
    expect(docRefusal("setup.exe", 10)).toMatch(/Programs and scripts/)
    expect(docRefusal("run.SH", 10)).toMatch(/Programs and scripts/)
    expect(docRefusal("a.docx", 0)).toMatch(/empty/)
    expect(docRefusal("", 10)).toMatch(/name/)
    expect(docRefusal("a/b.docx", 10)).toMatch(/slashes/)
    expect(docRefusal("x".repeat(201) + ".pdf", 10)).toMatch(/200/)
    expect(docRefusal("big.pdf", DOC_MAX_BYTES + 1)).toMatch(/too large/)
    expect(docRefusal("ok.pdf", DOC_MAX_BYTES)).toBeNull()
  })
  it("never puts anything but safe characters in a staging path", () => {
    expect(safeObjectName("Profilo società & servizi (v1).docx")).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(safeObjectName("....")).toBe("file")
    const p = stagingPathFor(OWNER, "../../evil name.docx", new Date(1_700_000_000_000), "rnd")
    expect(p.startsWith(`${DOCS_STAGING_PREFIX}${OWNER}/`)).toBe(true)
    expect(p).not.toContain("..")
    expect(p.slice(DOCS_STAGING_PREFIX.length + OWNER.length + 1)).not.toContain("/")
  })
  it("only accepts a staging path this storage issued", () => {
    expect(isOwnStagingPath(stagingPathFor(OWNER, "a.docx", new Date(), "r"), OWNER)).toBe(true)
    expect(isOwnStagingPath(stagingPathFor("22222222-2222-4222-8222-222222222222", "a.docx", new Date(), "r"), OWNER)).toBe(false)
    expect(isOwnStagingPath(`${DOCS_STAGING_PREFIX}${OWNER}/../x`, OWNER)).toBe(false)
    expect(isOwnStagingPath(`${DOCS_STAGING_PREFIX}${OWNER}/a/b`, OWNER)).toBe(false)
    expect(isOwnStagingPath("other/place/file", OWNER)).toBe(false)
  })
  it("shows plain sizes", () => {
    expect(formatDocSize(900)).toBe("900 B")
    expect(formatDocSize(84 * 1024)).toBe("84 KB")
    expect(formatDocSize(3.2 * 1024 * 1024)).toBe("3.2 MB")
    expect(formatDocSize(null)).toBe("")
  })
})

describe("Documents — who may do what", () => {
  it("the owner has both; a manager can read too; reading alone cannot change", () => {
    const owner = effectivePermissions({ memberRole: "owner", bundles: {} })
    expect(canReadDocuments(owner) && canManageDocuments(owner)).toBe(true)
    expect(canReadDocuments(["documents.manage"])).toBe(true)
    expect(canReadDocuments(["documents"])).toBe(true)
    expect(canManageDocuments(["documents"])).toBe(false)
    expect(canReadDocuments(["chat"])).toBe(false)
  })
  it("the built-in roles: everybody reads, the seller and the ad person also change, the setter and analyst do not", () => {
    const b = MARKETING_SETTING_DEFS.permission_bundles.fallback as Record<string, string[]>
    for (const role of ["setter", "seller", "content", "analyst"]) expect(canReadDocuments(b[role])).toBe(true)
    expect(canManageDocuments(b.seller)).toBe(true)
    expect(canManageDocuments(b.content)).toBe(true)
    expect(canManageDocuments(b.setter)).toBe(false)
    expect(canManageDocuments(b.analyst)).toBe(false)
  })
  it("both names are real permissions and the Documents screen is in the menu for readers only", () => {
    expect(MARKETING_PERMISSIONS).toContain("documents")
    expect(MARKETING_PERMISSIONS).toContain("documents.manage")
    expect(modulesFor(["documents"]).map(m => m.key)).toContain("documents")
    expect(modulesFor(["leads.read"]).map(m => m.key)).not.toContain("documents")
  })
})
