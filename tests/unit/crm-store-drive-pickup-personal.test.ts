import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { checkPersonalItem, type PersonalPickupItem } from "@/lib/crm-store/drive-pickup-personal"

const item: PersonalPickupItem = { documentId: "d1", contactId: "c1", driveFileId: "DRIVEID1234567890", name: "A.pdf", documentType: "credit_card_statement" }

describe("checkPersonalItem", () => {
  it("runs when the record still points at that Drive file and belongs to that person", () => {
    expect(checkPersonalItem(item, { drive_file_id: "DRIVEID1234567890", contact_id: "c1" })).toEqual({ ok: true })
  })
  it("a record with no person yet is fine (the list names the person)", () => {
    expect(checkPersonalItem(item, { drive_file_id: "DRIVEID1234567890", contact_id: null })).toEqual({ ok: true })
  })
  it("skips a record that no longer exists", () => {
    expect(checkPersonalItem(item, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) })
  })
  it("skips a record already moved (points somewhere else)", () => {
    expect(checkPersonalItem(item, { drive_file_id: "store:abc", contact_id: "c1" })).toMatchObject({ ok: false, reason: expect.stringMatching(/already moved/) })
  })
  it("skips a record that belongs to someone else — never guesses", () => {
    expect(checkPersonalItem(item, { drive_file_id: "DRIVEID1234567890", contact_id: "c2" })).toMatchObject({ ok: false, reason: expect.stringMatching(/different person/) })
  })
})
