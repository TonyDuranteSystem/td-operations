import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { t } from "@/lib/portal/i18n"

// QA 2026-11-06: a stale link to a CANCELLED closure opened the wizard and the send created a brand-new closure job. The refusal lives in the
// big submit route and the friendly card in the big wizard page, so these pin the wiring in the source (the real behaviour was proven in Chrome).
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

describe("a portal closure is only sent FOR a named, still-active closure", () => {
  const submit = read("app/api/portal/wizard-submit/route.ts")

  it("wizard-submit refuses a closure with no verified closure named (409, the same message as a closure that went away)", () => {
    const m = /if \(wizard_type === 'closure' && identity\.kind === 'contact' && !closureServiceDeliveryId\) \{\s*return NextResponse\.json\(\{ error: '([^']+)' \}, \{ status: 409 \}\)/.exec(submit)
    expect(m).not.toBeNull()
    expect(m![1]).toBe("This closure request is no longer available. Refresh the page and try again.")
  })

  it("the refusal sits AFTER the verification of a named closure and BEFORE any record is written", () => {
    const verified = submit.indexOf("verifyClosureServiceDelivery(String(rawServiceDeliveryId)")
    const refusal = submit.indexOf("!closureServiceDeliveryId) {")
    const validation = submit.indexOf("// ─── 0. SYNCHRONOUS VALIDATION ───")
    expect(verified).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(verified)
    expect(validation).toBeGreaterThan(refusal)
  })

  it("the wizard page says so up front when there is no active closure, instead of showing a wizard that would be refused", () => {
    const page = read("app/portal/wizard/page.tsx")
    expect(page).toContain("let closureUnavailable = false")
    expect(page).toContain("closureUnavailable = true")
    expect(page).toContain("if (closureUnavailable) {")
    expect(page).toContain("t('wizard.closureUnavailable', locale, translations)")
  })

  it("the message exists in English and Italian", () => {
    for (const key of ["wizard.closureUnavailable", "wizard.closureUnavailableText"]) {
      expect(t(key, "en")).not.toBe(key)
      expect(t(key, "it")).not.toBe(key)
      expect(t(key, "it")).not.toBe(t(key, "en"))
    }
  })
})
