import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { formationUploadType } from "@/lib/crm-store/formation-pilot"

describe("formationUploadType (Redstone Atlas EIN, 2026-10-29)", () => {
  it("the type picked at upload wins over the stage default", () => {
    expect(formationUploadType("ein_irs_fax_ltr_147c", "EIN Received")).toBe("ein_irs_fax_ltr_147c")
  })
  it("no pick falls back to the stage default", () => {
    expect(formationUploadType(null, "EIN Received")).toBe("ein_letter_irs")
    expect(formationUploadType(undefined, "Filed with State")).toBe("articles_of_organization")
    expect(formationUploadType("", "SS-4 Signed")).toBe("fax_confirmation")
  })
  it("a pick works even on an unmapped stage; nothing at all is unmapped", () => {
    expect(formationUploadType("ein_cp575b", "Other stage")).toBe("ein_cp575b")
    expect(formationUploadType(null, "Other stage")).toBeUndefined()
    expect(formationUploadType(null, null)).toBeUndefined()
  })
})

import { pickWelcomeDocs } from "@/lib/operations/welcome-docs"

describe("welcome package still finds an EIN letter that kept its specific type", () => {
  const row = (type: string, at: string) => ({ drive_file_id: `store:${type}`, file_name: "x.pdf", document_type_name: type, status: "classified", created_at: at })
  it.each(["EIN IRS FAX - LTR 147C", "EIN CP575B", "EIN CP575G", "EIN Letter (IRS)"])("finds %s", (t) => {
    expect(pickWelcomeDocs([row(t, "2026-10-29")]).ein?.pointer).toBe(`store:${t}`)
  })
  it("a different EIN document type is not mistaken for the letter", () => {
    expect(pickWelcomeDocs([row("EIN Cancellation Request", "2026-10-29")]).ein).toBeNull()
  })
})
