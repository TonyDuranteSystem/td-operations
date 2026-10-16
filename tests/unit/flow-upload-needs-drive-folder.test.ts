import { describe, it, expect } from "vitest"
import { needsDriveFolder } from "@/lib/flows/flow-drive-folder"

describe("needsDriveFolder", () => {
  it("a company still on Drive needs its Drive folder", () => {
    expect(needsDriveFolder({ sandbox: false, routed: false, storeSaved: false })).toBe(true)
  })
  it("a file already saved in the company's storage never needs a Drive folder (Redstone Atlas)", () => {
    expect(needsDriveFolder({ sandbox: false, routed: false, storeSaved: true })).toBe(false)
    expect(needsDriveFolder({ sandbox: false, routed: true, storeSaved: false })).toBe(false)
  })
  it("the sandbox never needs one", () => {
    expect(needsDriveFolder({ sandbox: true, routed: false, storeSaved: false })).toBe(false)
  })
})
