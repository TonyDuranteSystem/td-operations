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
import { WIZARD_LABELS, wizardLabelFor, completeWizardFormTitle, startWizardFormTitle } from "@/lib/portal/wizard-labels"
import { VALID_WIZARD_TYPES } from "@/lib/portal/wizard-map"
import { SERVICES_STATIC } from "@/lib/services"

describe("wizard labels", () => {
  it("every wizard type the portal accepts has a real label in both languages", () => {
    const leaking: string[] = []
    for (const type of VALID_WIZARD_TYPES) {
      const { en, it: itLabel, itOf } = wizardLabelFor(type)
      if (en === type) leaking.push(`${type} (en)`)
      if (itLabel === type) leaking.push(`${type} (it)`)
      if (itOf === type) leaking.push(`${type} (itOf)`)
      if (!en.trim() || !itLabel.trim() || !itOf.trim()) leaking.push(`${type} (empty)`)
    }
    expect(
      leaking,
      `These wizard types would render their INTERNAL CODE to a client:\n  ${leaking.join("\n  ")}\nAdd a human label to lib/portal/wizard-labels.ts.`,
    ).toEqual([])
  })

  it("no label is an internal-looking code (snake_case leaks past a human eye)", () => {
    const suspicious = Object.entries(WIZARD_LABELS)
      .filter(([, l]) => l.en.includes("_") || l.it.includes("_") || l.itOf.includes("_"))
      .map(([t]) => t)
    expect(suspicious, "A label containing '_' is almost certainly the raw type.").toEqual([])
  })

  it("every Italian fragment starts with a preposition — the grammar bug", () => {
    // "Completa il modulo Costituzione" is wrong; "…il modulo DI Costituzione"
    // is right. Shipped once, caught in QA. The fragment must slot into
    // "il modulo ___" and read as Italian.
    const bad = Object.entries(WIZARD_LABELS)
      .filter(([t, l]) => !/^(di |per |dell|ITIN$)/.test(l.itOf) && t !== "itin")
      .map(([t, l]) => `${t}: "il modulo ${l.itOf}"`)
    expect(bad, `These read wrong in Italian:\n  ${bad.join("\n  ")}`).toEqual([])
  })

  it("resolves tax_return — the service slug that leaks into wizard call sites", () => {
    expect(wizardLabelFor("tax_return").en).toBe("Tax Return")
    expect(wizardLabelFor("tax_return").it).toBe("Dichiarazione Fiscale")
  })

  it("builds the client-facing title in both languages", () => {
    expect(completeWizardFormTitle("banking_payset", "en")).toBe("Complete your Payset Bank Account form")
    expect(completeWizardFormTitle("banking_payset", "it")).toBe("Completa il modulo per il Conto Bancario Payset")
    expect(completeWizardFormTitle("formation", "it")).toBe("Completa il modulo di Costituzione LLC")
    // the exact string the three affected clients were seeing
    expect(completeWizardFormTitle("banking_payset", "en")).not.toContain("banking_payset")
    expect(completeWizardFormTitle("banking_relay", "en")).not.toContain("banking_relay")
  })

  it("the two cards that render in the SAME list agree with each other", () => {
    // An Italian client saw "Completa il modulo Costituzione" directly above
    // "Inizia il modulo di Chiusura Società" — two grammars, one list.
    for (const type of VALID_WIZARD_TYPES) {
      const done = completeWizardFormTitle(type, "it")
      const start = startWizardFormTitle(type, "it")
      expect(done.replace(/^Completa /, ""), `grammar drift on ${type}`).toBe(start.replace(/^Inizia /, ""))
      expect(
        startWizardFormTitle(type, "en").replace(/^Start your /, ""),
        `grammar drift on ${type} (en)`,
      ).toBe(completeWizardFormTitle(type, "en").replace(/^Complete your /, ""))
    }
  })

  it("no title ever contains a raw wizard type, on either card, in either language", () => {
    const leaks: string[] = []
    for (const type of [...VALID_WIZARD_TYPES, "tax_return"]) {
      for (const build of [completeWizardFormTitle, startWizardFormTitle]) {
        for (const lang of ["en", "it"] as const) {
          const out = build(type, lang)
          if (out.includes(type)) leaks.push(`${type}/${lang}: "${out}"`)
        }
      }
    }
    expect(leaks, `Raw type leaked into a client-facing title:\n  ${leaks.join("\n  ")}`).toEqual([])
  })

  it("falls back to the raw value only for a genuinely unknown type", () => {
    expect(wizardLabelFor("not_a_wizard").en).toBe("not_a_wizard")
  })

  it("uses the SERVICE CATALOG's name — never invents its own", () => {
    // The first version of this file renamed closure to "LLC Closure" while the
    // catalog, the guide, the wizard page and the services list all said
    // "Company Closure" — a vocabulary fork created by the commit whose entire
    // purpose was to END vocabulary forks. The catalog is the source of truth
    // (R106); this map follows it.
    const CATALOG_SLUG_FOR: Partial<Record<string, string>> = {
      formation: "llc_formation",
      onboarding: "onboarding",
      tax: "tax_return",
      itin: "itin",
      closure: "closure",
    }
    const forks: string[] = []
    for (const [wizardType, slug] of Object.entries(CATALOG_SLUG_FOR)) {
      const entry = SERVICES_STATIC.find(s => s.slug === slug)
      if (!entry) {
        forks.push(`${wizardType}: catalog slug "${slug}" no longer exists — fix this test's map`)
        continue
      }
      const ours = wizardLabelFor(wizardType)
      if (ours.en !== entry.display_name) {
        forks.push(`${wizardType}: label "${ours.en}" != catalog "${entry.display_name}"`)
      }
      const catalogIt = entry.display_name_translations?.it
      if (catalogIt && ours.it !== catalogIt) {
        forks.push(`${wizardType} (it): label "${ours.it}" != catalog "${catalogIt}"`)
      }
    }
    expect(
      forks,
      `Wizard labels have forked from the service catalog:\n  ${forks.join("\n  ")}\nRename it in the catalog first, then follow — do not invent a name here.`,
    ).toEqual([])
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

  it("the client-visible activity log never interpolates the raw type", () => {
    // Found in QA AFTER the first fix shipped: the portal chat "Log" tab said
    // "Wizard started — banking_payset" to the same three clients. 'wizard'
    // events are whitelisted for clients in lib/portal/journey-events.ts and
    // rendered verbatim, so this file is a client-facing surface.
    const activity = readFileSync("lib/operations/account-activity.ts", "utf8")
    // Split so the needle is not itself a template expression (ESLint).
    const rawInterpolation = "${" + "w.wizard_type}"
    expect(
      activity.includes(rawInterpolation),
      "account-activity.ts is interpolating the raw wizard_type into a title the CLIENT reads. Use wizardLabelFor().",
    ).toBe(false)
    expect(
      activity.includes("wizardLabelFor"),
      "account-activity.ts should build wizard titles through the shared label map.",
    ).toBe(true)
  })

  it("the wizard page tab strip uses the shared labels and is localized", () => {
    // It used to hardcode "Payset (EUR)" / "LLC Formation" in English only, so
    // a client clicked "Complete your Payset Bank Account form" and landed on a
    // tab that said something else — in English even with the portal in Italian.
    const page = readFileSync("app/portal/wizard/page.tsx", "utf8")
    expect(page.includes("label: 'Payset (EUR)'"), "hardcoded tab label is back").toBe(false)
    expect(page.includes("label: 'Relay (USD)'"), "hardcoded tab label is back").toBe(false)
    expect(
      page.includes("locale === 'it' ? w.labelIt : w.label"),
      "the tab strip must render the Italian label when the portal is Italian",
    ).toBe(true)
  })

  it("no inline ternary names wizard types by hand again", () => {
    expect(
      queries.includes("=== 'formation' ? 'Formation'"),
      "The hand-rolled label ternary is back in queries.ts. Use completeWizardFormTitle / wizardLabelFor.",
    ).toBe(false)
  })
})
