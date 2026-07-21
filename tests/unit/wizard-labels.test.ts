/**
 * THE GUARD against shipping an internal wizard code to a client.
 *
 * This exact defect shipped twice in two days:
 *   2026-07-20 — reminder email said "Complete your banking_relay form".
 *   2026-07-21 — the portal home said "Complete banking_payset Form" to three
 *                real clients (TFC Management LLC, PTBT Holding LLC,
 *                LC Marketing Consulting LLC), because the 07-20 fix was made
 *                inside the cron's own private label map and four other maps
 *                existed.
 *
 * The compiler now catches a MISSING label (WIZARD_LABELS is
 * Record<WizardType, …>). These tests catch the things the compiler cannot:
 * a label that is present but still the raw code, an alias that resolves
 * nowhere, and a call site that stops using the shared helper.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { WIZARD_LABELS, wizardLabelFor, completeWizardFormTitle } from "@/lib/portal/wizard-labels"
import { VALID_WIZARD_TYPES } from "@/lib/portal/wizard-map"

describe("wizard labels", () => {
  it("every wizard type the portal accepts has a real label in both languages", () => {
    const leaking: string[] = []
    for (const type of VALID_WIZARD_TYPES) {
      const { en, it: itLabel } = wizardLabelFor(type)
      if (en === type) leaking.push(`${type} (en)`)
      if (itLabel === type) leaking.push(`${type} (it)`)
      if (!en.trim() || !itLabel.trim()) leaking.push(`${type} (empty)`)
    }
    expect(
      leaking,
      `These wizard types would render their INTERNAL CODE to a client:\n  ${leaking.join("\n  ")}\nAdd a human label to lib/portal/wizard-labels.ts.`,
    ).toEqual([])
  })

  it("no label is an internal-looking code (snake_case leaks past a human eye)", () => {
    const suspicious = Object.entries(WIZARD_LABELS)
      .filter(([, l]) => l.en.includes("_") || l.it.includes("_"))
      .map(([t]) => t)
    expect(suspicious, "A label containing '_' is almost certainly the raw type.").toEqual([])
  })

  it("resolves tax_return — the service slug that leaks into wizard call sites", () => {
    expect(wizardLabelFor("tax_return").en).toBe("Tax Return")
    expect(wizardLabelFor("tax_return").it).toBe("Dichiarazione Fiscale")
  })

  it("builds the client-facing title in both languages", () => {
    expect(completeWizardFormTitle("banking_payset", "en")).toBe("Complete your Payset Bank Account form")
    expect(completeWizardFormTitle("banking_payset", "it")).toBe("Completa il modulo Conto Bancario Payset")
    // the exact string the three affected clients were seeing
    expect(completeWizardFormTitle("banking_payset", "en")).not.toContain("banking_payset")
    expect(completeWizardFormTitle("banking_relay", "en")).not.toContain("banking_relay")
  })

  it("falls back to the raw value only for a genuinely unknown type", () => {
    expect(wizardLabelFor("not_a_wizard").en).toBe("not_a_wizard")
  })
})

describe("the portal home cannot reintroduce its own label map", () => {
  const queries = readFileSync("lib/portal/queries.ts", "utf8")

  it("builds every in-progress form card through the shared helper", () => {
    // Both action-item builders (account scope and contact scope) were
    // byte-identical copies of the same broken ternary. If a third copy
    // appears, or one reverts, this catches it.
    const viaHelper = queries.match(/completeWizardFormTitle\(w\.wizard_type/g) ?? []
    expect(viaHelper.length, "Expected both action-item builders to use the shared title helper.").toBe(4)
  })

  it("no inline ternary names wizard types by hand again", () => {
    expect(
      queries.includes("=== 'formation' ? 'Formation'"),
      "The hand-rolled label ternary is back in queries.ts. Use completeWizardFormTitle / wizardLabelFor.",
    ).toBe(false)
  })
})
