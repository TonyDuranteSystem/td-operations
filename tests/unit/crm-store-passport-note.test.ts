import { describe, it, expect } from "vitest"
import { passportReadNote } from "@/lib/crm-store/browse"

describe("passportReadNote — the passport reader's result in plain words", () => {
  it("names the fields that were saved", () => {
    expect(passportReadNote({ status: "ok", extracted_fields: ["passport_number", "passport_expiry_date"] })).toBe("Passport read — passport number, expiry date saved on the contact.")
  })
  it("nothing matched → asks for manual entry, never the reader's technical text", () => {
    const t = passportReadNote({ status: "ok", extracted_fields: [] })
    expect(t).toMatch(/could not be read automatically/)
    expect(t).not.toMatch(/MRZ|OCR/)
  })
  it("a save error and an unreadable format each get their own plain message", () => {
    expect(passportReadNote({ status: "error" })).toMatch(/could not be saved on the contact/)
    expect(passportReadNote({ status: "skipped", manual_task_created: true })).toMatch(/can't be read automatically/)
  })
  it("an unknown field name is still readable", () => {
    expect(passportReadNote({ status: "ok", extracted_fields: ["nationality_code"] })).toBe("Passport read — nationality code saved on the contact.")
  })
})
