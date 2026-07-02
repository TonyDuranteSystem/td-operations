import { describe, it, expect } from "vitest"
import { actionStageConfigFor } from "@/lib/portal/action-stage-registry"

describe("actionStageConfigFor", () => {
  it("returns config for registered action stages", () => {
    const tax = actionStageConfigFor("Tax Return", "Wizard Available")
    expect(tax).not.toBeNull()
    expect(tax!.link).toBe("/portal/wizard")
    expect(tax!.title.en).toContain("tax form")
    expect(tax!.title.it).toContain("modulo")

    const itin = actionStageConfigFor("ITIN", "Client Signing")
    expect(itin).not.toBeNull()
    expect(itin!.link).toContain("{sd_id}")
    expect(itin!.message.en).toContain("wet ink")
    expect(itin!.message.it).toContain("passaporto")
  })

  it("returns null for ordinary stages and unknown types", () => {
    expect(actionStageConfigFor("Tax Return", "Under Review")).toBeNull()
    expect(actionStageConfigFor("ITIN", "Document Preparation")).toBeNull()
    expect(actionStageConfigFor("Company Formation", "SS-4 Prepared")).toBeNull() // artifact-driven, not stage-driven
    expect(actionStageConfigFor(null, "Wizard Available")).toBeNull()
    expect(actionStageConfigFor("Tax Return", null)).toBeNull()
  })
})
