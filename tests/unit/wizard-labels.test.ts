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
import { WIZARD_LABELS, wizardLabelFor, completeWizardFormTitle, startWizardFormTitle, offerTypeLabel } from "@/lib/portal/wizard-labels"
import { VALID_WIZARD_TYPES } from "@/lib/portal/wizard-map"
import { SERVICES_STATIC } from "@/lib/services"

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

  it("THE NAME COMES FIRST — the card must be distinguishable when truncated", () => {
    // Measured on the real page at 380px (Antonio runs the whole thing as a
    // phone app): the title sits in a ~196px truncating column. The first
    // version led with the verb — "Completa il modulo per il Conto Bancario
    // Payset" — which clipped to "Completa il modulo per il C…", so a client
    // holding BOTH bank forms saw two cards that read identically. The name
    // must therefore appear inside the first ~25 characters.
    const VISIBLE = 25
    const collisions: string[] = []
    const seen = new Map<string, string>()
    for (const type of VALID_WIZARD_TYPES) {
      for (const lang of ["en", "it"] as const) {
        for (const build of [completeWizardFormTitle, startWizardFormTitle]) {
          const head = build(type, lang).slice(0, VISIBLE)
          const key = `${lang}:${build.name}:${head}`
          const prev = seen.get(key)
          if (prev && prev !== type) collisions.push(`${prev} vs ${type} both start "${head}"`)
          seen.set(key, type)
        }
      }
    }
    expect(
      collisions,
      `Two cards would look IDENTICAL on a phone:\n  ${collisions.join("\n  ")}\nLead the title with the form name.`,
    ).toEqual([])
  })

  it("an ITIN Renewal client is not told to start an ITIN Application", () => {
    expect(startWizardFormTitle("itin", "en", "ITIN Renewal")).toBe("ITIN Renewal — start your form")
    expect(startWizardFormTitle("itin", "en", "ITIN")).toBe("ITIN Application — start your form")
    expect(wizardLabelFor("itin", "ITIN Renewal").it).toBe("Rinnovo ITIN")
  })

  it("offer types never reach the client's journey feed as a raw code", () => {
    // Verified against production 2026-07-21: renewal 162, formation 59,
    // onboarding 14, tax_return 4, itin 1.
    for (const t of ["renewal", "formation", "onboarding", "tax_return", "itin", "banking"]) {
      expect(offerTypeLabel(t), `no label for offer type "${t}"`).toBeTruthy()
      expect(offerTypeLabel(t)).not.toBe(t)
    }
    // An unknown type yields NO suffix rather than a raw code.
    expect(offerTypeLabel("something_new")).toBeNull()
    expect(offerTypeLabel(null)).toBeNull()
  })

  it("resolves tax_return — the service slug that leaks into wizard call sites", () => {
    expect(wizardLabelFor("tax_return").en).toBe("Tax Return")
    expect(wizardLabelFor("tax_return").it).toBe("Dichiarazione dei redditi annuale")
  })

  it("builds the client-facing title in both languages, name first", () => {
    // Wording chosen by Antonio 2026-07-21.
    expect(completeWizardFormTitle("banking_payset", "it")).toBe("Conto Bancario Payset — completa il modulo")
    expect(completeWizardFormTitle("banking_payset", "en")).toBe("Payset Bank Account — complete your form")
    expect(startWizardFormTitle("banking_relay", "it")).toBe("Conto Bancario Relay — inizia il modulo")
    expect(completeWizardFormTitle("formation", "it")).toBe("Costituzione LLC — completa il modulo")
    // the exact codes the three affected clients were seeing
    expect(completeWizardFormTitle("banking_payset", "en")).not.toContain("banking_payset")
    expect(completeWizardFormTitle("banking_relay", "en")).not.toContain("banking_relay")
  })

  it("the two cards that render in the SAME list agree with each other", () => {
    // An Italian client saw "Completa il modulo Costituzione" directly above
    // "Inizia il modulo di Chiusura Società" — two shapes, one list.
    for (const type of VALID_WIZARD_TYPES) {
      for (const lang of ["en", "it"] as const) {
        const done = completeWizardFormTitle(type, lang)
        const start = startWizardFormTitle(type, lang)
        const label = lang === "it" ? wizardLabelFor(type).it : wizardLabelFor(type).en
        expect(done.startsWith(`${label} — `), `${type}/${lang} complete-card must lead with the name`).toBe(true)
        expect(start.startsWith(`${label} — `), `${type}/${lang} start-card must lead with the name`).toBe(true)
      }
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
