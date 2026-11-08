/**
 * Company Closure Part C (dev job a6bbea09) — the pieces that live inside routes and pages are wired to the helpers the unit tests
 * cover. Source-shape checks, so a later edit cannot quietly route around a fix.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

describe("closing the company", () => {
  const sd = read("lib/service-delivery.ts")
  const section = sd.slice(sd.indexOf("// 14. Company Closure"), sd.indexOf("// 15. Action log"))

  it("the finishing step hands the whole job to applyCompanyClosure (no inline copy left to drift)", () => {
    expect(section).toContain("applyCompanyClosure(")
    expect(section).not.toContain("service_deliveries\")\n        .update")
    expect(section).not.toContain('"Account → Closed')
  })

  it("it can be told to finish the job WITHOUT closing the company, and says so", () => {
    expect(section).toContain("skip_company_close")
    expect(section).toContain("Company left open")
  })

  it("a failed step becomes a 'Closure problem:' line, and the advance route turns it into the warning staff see", () => {
    expect(section).toContain("Closure problem: ")
    const route = read("app/api/flows/[id]/advance/route.ts")
    expect(route).toContain("Closure problem: ")
    expect(route).toContain("skip_company_close: body.skip_company_close === true")
  })

  it("the question reads the brief and offers 'finish without closing' only on a mismatch warning", () => {
    const ui = read("components/flows/closing-question.tsx")
    expect(ui).toContain("/closing-brief")
    expect(ui).toContain("Finish the job without closing the company")
    expect(ui).toContain("brief?.warning")
    expect(read("components/flows/action-buttons.tsx")).toContain("skip_company_close: true")
  })
})

describe("the workspace upload, chat, offers, wizard drafts and the client's screen", () => {
  it("a company with no storage gets its storage opened before the upload is refused", () => {
    const route = read("app/api/flows/[id]/upload-document/route.ts")
    const open = route.indexOf("openStorageForOpenCompany(accountId)")
    const state = route.indexOf("companyDocState(accountId)) !== 'drive'")
    expect(open).toBeGreaterThan(-1)
    expect(state).toBeGreaterThan(open)
  })

  it("staff chat on a company goes to the buyer, not to whoever the database lists first", () => {
    const route = read("app/api/flows/[id]/chat/route.ts")
    expect(route).toContain("pickChatContact(")
    expect(route).toContain("jobContactId")
  })

  it("the duplicate-offer check uses the shared scope rule", () => {
    expect(read("lib/operations/offers.ts")).toContain("duplicateOfferScope(")
  })

  it("the wizard draft is created through the one-draft helper, and the CRM card hides a leftover twin", () => {
    expect(read("app/api/portal/wizard-progress/route.ts")).toContain("createOrReuseWizardProgress(")
    expect(read("app/(dashboard)/accounts/[id]/page.tsx")).toContain("dropSupersededDrafts(")
  })

  it("the portal home says the company is closed instead of the new-client screen", () => {
    const page = read("app/portal/page.tsx")
    const closed = page.indexOf("showClosedCompanyNotice(")
    const welcome = page.indexOf("wizardReviewed = !!reviewedOs", closed)
    expect(closed).toBeGreaterThan(-1)
    expect(page.indexOf("<ClosedCompanyCard", closed)).toBeGreaterThan(closed)
    expect(welcome).toBeGreaterThan(closed)
  })
})

describe("the closure steps create no plain to-do cards", () => {
  it("the migration empties every Company Closure step's list and its undo puts the exact lists back", () => {
    const up = read("scripts/migrations/20261107-0100-closure-no-stage-todos.sql")
    const undo = read("scripts/migrations/20261107-0100-closure-no-stage-todos.UNDO.sql")
    expect(up).toContain("auto_tasks = '[]'::jsonb")
    for (const step of ["Data Collection", "State Compliance Check", "State Dissolution Filing", "IRS Closure", "Closing"]) {
      expect(up, step).toContain(`'${step}'`)
      expect(undo, step).toContain(`stage_name = '${step}'`)
    }
    expect(undo).toContain("Notify client that closure is complete")
    expect(up).not.toContain("DELETE")
  })
})
