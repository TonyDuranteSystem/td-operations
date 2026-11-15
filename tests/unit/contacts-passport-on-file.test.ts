import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { isLegacyPassportDoc, passportOnFile } from "@/lib/contacts/passport-on-file"

describe("passportOnFile", () => {
  it("is Yes when the flag is Yes, whatever the files say", () => {
    expect(passportOnFile(true, false)).toBe(true)
  })
  it("is Yes when a passport file exists even if the flag was never set or says No", () => {
    expect(passportOnFile(null, true)).toBe(true)
    expect(passportOnFile(undefined, true)).toBe(true)
    expect(passportOnFile(false, true)).toBe(true)
  })
  it("is No only when there is no flag and no file", () => {
    expect(passportOnFile(null, false)).toBe(false)
    expect(passportOnFile(false, false)).toBe(false)
  })
})

describe("isLegacyPassportDoc", () => {
  it("counts an old Drive-era passport row", () => {
    expect(isLegacyPassportDoc({ document_type_name: "Passport", drive_file_id: "1AbC" })).toBe(true)
  })
  it("skips a store pointer (the store file is counted on its own, and may be trashed)", () => {
    expect(isLegacyPassportDoc({ document_type_name: "Passport", drive_file_id: "store:9a49787e-2f1d-413e-97e4-cbb862b797c2" })).toBe(false)
  })
  it("skips other document types and empty rows", () => {
    expect(isLegacyPassportDoc({ document_type_name: "Articles of Organization", drive_file_id: "x" })).toBe(false)
    expect(isLegacyPassportDoc({ document_type_name: null, drive_file_id: null })).toBe(false)
  })
})
