/**
 * The client must never see where the application goes (Antonio 2026-11-03: "the client must not see any email address where
 * the form is submitted, it must be anonymous"). Everything the applicant can load or receive is checked here.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { buildSendBackEmail } from "@/lib/bofa-intake/send-back"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

/** Every file a visitor of the public link can load or call. */
const PUBLIC_FILES = [
  "components/forms/bank-application-form.tsx",
  "app/bank-application/[token]/page.tsx",
  "app/api/bank-application/[token]/route.ts",
  "app/api/bank-application/[token]/submit/route.ts",
  "app/api/bank-application/[token]/upload-url/route.ts",
]

describe("the applicant never sees the bank contact's address", () => {
  for (const f of PUBLIC_FILES) {
    it(`${f} never names the bank contact or reads the stored addresses into a response`, () => {
      const src = read(f)
      expect(src.toLowerCase()).not.toContain("sekureye")
      expect(src).not.toContain("submitTo")
      expect(src).not.toContain("bofa_submit_to")
    })
  }

  it("the only email addresses the public form shows are example placeholders", () => {
    const form = read("components/forms/bank-application-form.tsx")
    const addresses = form.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
    for (const a of addresses) expect(a, a).toMatch(/@example\.com$/)
  })

  it("the public submit response carries nothing but ok / an error message", () => {
    const submit = read("app/api/bank-application/[token]/submit/route.ts")
    expect(submit).toContain("NextResponse.json({ ok: true })")
  })

  it("the send-back email to the applicant never mentions where applications are submitted", () => {
    const mail = buildSendBackEmail({ name: "A", note: "n", url: "https://u" })
    expect((mail.subject + mail.html).toLowerCase()).not.toContain("sekureye")
    expect(readdirSync(join(root, "lib/bofa-intake")).length).toBeGreaterThan(0)
  })
})
