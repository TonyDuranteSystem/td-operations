/** Source checks that pin the promises of the review gate (the unit suite has no browser). */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
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

describe("who may change where passports go", () => {
  const settings = read("app/api/bofa-intake-admin/settings/route.ts")
  it("only the owner can save; anyone with Forms can read", () => {
    expect(settings).toContain("isOwnerOnly(user)")
    expect(settings).toContain("Only the owner can change these addresses.")
  })
  it("the Forms card is the settings place: the two addresses live there, and there is no per-link address box", () => {
    const forms = read("app/(dashboard)/forms/page.tsx")
    expect(forms).not.toContain("Send the submitted form to")
    expect(forms).toContain("BankApplicationSettings")
    const create = read("app/api/bofa-intake-admin/route.ts")
    expect(create).not.toContain("parseRecipients")
  })
})

describe("Send back offers a link to share by hand", () => {
  it("the dialog has Create link only, and it asks the server for no email", () => {
    const page = read("app/(dashboard)/bofa-intake/page.tsx")
    expect(page).toContain("Create link only")
    expect(page).toContain("email: false")
    expect(page).toContain("WhatsApp")
    expect(read("app/api/bofa-intake-admin/[id]/route.ts")).toContain("email: body.email !== false")
  })
})

describe("the Seminole shipping address on the client form", () => {
  const form = read("components/forms/bank-application-form.tsx")
  it("has no company-name line and no explanatory wording, only the heading and the address", () => {
    expect(form).not.toContain("shipping_name")
    expect(read("lib/bofa-intake/shipping.ts")).not.toMatch(/shipping_name:/)
    expect(form).not.toContain("Where the bank sends your cards and letters")
    expect(form).not.toContain("filled in for you and cannot be changed")
    expect(form).toContain("Shipping address")
  })
})

describe("the Applications tab is only for people who may use Forms", () => {
  const page = read("app/(dashboard)/new-calendar/page.tsx")
  it("is loaded and shown only behind the Forms rule, and a typed address falls back to the first tab", () => {
    expect(page).toContain("canUseForms(access.user)")
    expect(page).toContain("requested.tab === 'applications' && !seesApplications")
  })
})

describe("undo send back and the upload sweeper are wired in", () => {
  it("the staff route has an undo_send_back action that emails nobody", () => {
    const admin = read("app/api/bofa-intake-admin/[id]/route.ts")
    expect(admin).toContain('body.action === "undo_send_back"')
    const lib = read("lib/bofa-intake/undo-send-back.ts")
    for (const forbidden of ["gmailPost", "sendHtmlEmail", "deliverSubmission"]) expect(lib, forbidden).not.toContain(forbidden)
  })
  it("the staff page offers Undo send back through the same rule the server uses", () => {
    const page = read("app/(dashboard)/bofa-intake/page.tsx")
    expect(page).toContain("canUndoSendBack")
    expect(page).toContain('"undo_send_back"')
  })
  it("the sweeper only ever removes from the intake's own bucket, never from CRM Storage", () => {
    const sweep = read("lib/bofa-intake/upload-sweep.ts")
    expect(sweep).toContain("storage.from(BOFA_BUCKET)")
    for (const forbidden of ["store_files", "store_file_versions", "saveBytesToStore", "crm-store", "trashed_at"]) {
      // mentions in the explaining comment are fine; code must not use them
      const code = sweep.replace(/\/\*[\s\S]*?\*\//g, "")
      expect(code, forbidden).not.toContain(forbidden)
    }
  })
  it("the cron route fails closed without the secret and is scheduled daily", () => {
    const cron = read("app/api/cron/bofa-upload-sweep/route.ts")
    expect(cron).toContain("!process.env.CRON_SECRET")
    expect(read("vercel.json")).toContain('"/api/cron/bofa-upload-sweep"')
  })
})
