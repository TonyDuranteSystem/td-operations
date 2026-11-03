/** Source checks that pin the promises of the review gate (the unit suite has no browser). */
import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

describe("the client's submit no longer sends anything outside", () => {
  const submit = read("app/api/bank-application/[token]/submit/route.ts")

  it("does not import or call the bank-contact sender", () => {
    expect(submit).not.toContain("deliverSubmission")
    expect(submit).not.toContain("@/lib/bofa-intake/deliver")
  })
  it("stamps the shipping address on the server", () => {
    expect(submit).toContain("withShippingAddress(result.data)")
  })
  it("writes none of the review columns, and its one read of the new replaces_id column is tolerant, so a client's submission can never break on it", () => {
    for (const col of ["reviewed_at", "reviewed_by", "sent_by", "sent_to", "returned_at", "return_note", "staff_note"]) {
      expect(submit, col).not.toContain(col)
    }
    const reader = submit.slice(submit.indexOf("async function isResubmission"), submit.indexOf("async function notifyStaff"))
    expect(reader).toContain('select("replaces_id")')
    expect(reader).toContain("catch")
    expect(reader).not.toContain(".update(")
  })
  it("tells our people when a corrected application was resubmitted", () => {
    expect(submit).toContain("Bank application RESUBMITTED")
    expect(submit).toContain("await isResubmission(updated.id)")
  })
  it("tells the saved 'told when one arrives' list, with a link and no answers", () => {
    expect(submit).toContain("loadBofaSettings")
    const notice = submit.slice(submit.indexOf("async function notifyStaff"), submit.indexOf("export async function POST"))
    expect(notice).toContain("settings.notifyTo")
    expect(notice).toContain("/bofa-intake?open=")
    for (const forbidden of ["form_data", "full_name", "passport", "result.data", "files"]) expect(notice, forbidden).not.toContain(forbidden)
  })
})

describe("the review rule lives inside the send", () => {
  it("every claim to send requires Reviewed and not sent back", () => {
    const deliver = read("lib/bofa-intake/deliver.ts")
    expect(deliver).toContain('.not("reviewed_at", "is", null)')
    expect(deliver).toContain('.is("returned_at", null)')
  })
  it("the only caller is the staff route's submit action", () => {
    const admin = read("app/api/bofa-intake-admin/[id]/route.ts")
    expect(admin).toContain('body.action === "submit"')
    expect(admin).not.toContain("resend_email")
    const lib = ["lib/bofa-intake/review.ts", "lib/bofa-intake/send-back.ts", "lib/bofa-intake/archive.ts", "lib/bofa-intake/waiting.ts"]
    for (const f of lib) expect(read(f), f).not.toContain("deliverSubmission")
  })
  it("the staff page has no Resend / Email again button any more", () => {
    const page = read("app/(dashboard)/bofa-intake/page.tsx")
    expect(page).not.toContain("resend_email")
    expect(page).not.toContain("Email again")
    expect(page).not.toContain("Resend email")
  })
})

describe("no email address on any form card (Antonio 2026-11-03)", () => {
  it("the Forms page has no address boxes, no Save addresses button and no per-link recipients box", () => {
    const forms = read("app/(dashboard)/forms/page.tsx")
    expect(forms).not.toContain("Send the submitted form to")
    expect(forms).not.toContain("BankApplicationSettings")
    expect(forms).not.toMatch(/Save addresses|type="email"|aria-label="Applications are submitted to"/)
    expect(existsSync(join(root, "components/forms/bank-application-settings.tsx"))).toBe(false)
    expect(read("app/api/bofa-intake-admin/route.ts")).not.toContain("parseRecipients")
  })
  it("nothing in the CRM writes the stored addresses: the settings route is read-only", () => {
    const route = read("app/api/bofa-intake-admin/settings/route.ts")
    expect(route).toContain("export async function GET")
    expect(route).not.toMatch(/export async function (PUT|POST|PATCH|DELETE)/)
    expect(read("lib/bofa-intake/settings.ts")).not.toContain("saveBofaSettings")
  })
  it("the shipping address on the form has no company name line", () => {
    expect(read("components/forms/bank-application-form.tsx")).not.toContain("shipping_name")
    expect(read("lib/bofa-intake/shipping.ts")).not.toMatch(/shipping_name:/)
  })
})

describe("the Applications tab is only for people who may use Forms", () => {
  const page = read("app/(dashboard)/new-calendar/page.tsx")
  it("is loaded and shown only behind the Forms rule, and a typed address falls back to the first tab", () => {
    expect(page).toContain("canUseForms(access.user)")
    expect(page).toContain("requested.tab === 'applications' && !seesApplications")
  })
})
