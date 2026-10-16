import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { matchPickup, pickupEnabled, type ScannedFile } from "@/lib/crm-store/drive-pickup"

const f = (id: string, name: string, path: string[] = ["3. Tax", "2025"]): ScannedFile => ({ id, name, path, mime: "application/pdf" })

describe("Drive pickup", () => {
  it("is off unless STORE_DRIVE_PICKUP=1", () => {
    expect(pickupEnabled({})).toBe(false)
    expect(pickupEnabled({ STORE_DRIVE_PICKUP: "1" })).toBe(true)
  })
  it("finds the ONE file with that exact name", () => {
    const r = matchPickup([f("a", "Signed_for_IRS.pdf"), f("b", "Other.pdf")], "Signed_for_IRS.pdf")
    expect(r).toEqual({ file: f("a", "Signed_for_IRS.pdf") })
  })
  it("never guesses: no file, or two files with that name, is skipped with a reason", () => {
    expect("reason" in matchPickup([f("b", "Other.pdf")], "Signed_for_IRS.pdf")).toBe(true)
    const two = matchPickup([f("a", "X.pdf"), f("b", "X.pdf", ["1. Company"])], "X.pdf")
    expect("reason" in two && two.reason).toMatch(/2 files/)
  })
  it("matches the name exactly (a similar name is not the file)", () => {
    expect("reason" in matchPickup([f("a", "Signed_for_IRS (1).pdf")], "Signed_for_IRS.pdf")).toBe(true)
  })
})
