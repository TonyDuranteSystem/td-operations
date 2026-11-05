import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * Two things about the Service Catalog editor and Create Offer (flexible-offer track):
 *  1. The "Add a new service" button in Create Offer was DELETED on Antonio's word (2026-11-04): the editor is too technical
 *     for him, new services are set up with Claude. Create Offer must not link to the editor or read the list again behind
 *     the user's back.
 *  2. Two small fixes made in the editor stay (they are not behind any switch): a non-admin gets a plain answer, and a
 *     half-made new service is reported and reopened instead of asking to create it again.
 */
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

const dialog = strip(read("components/offers/create-offer-dialog.tsx"))
const newPage = strip(read("app/(dashboard)/service-catalog/new/page.tsx"))
const editor = strip(read("app/(dashboard)/service-catalog/service-edit-client.tsx"))
const actions = strip(read("app/(dashboard)/service-catalog/actions.ts"))

describe("Create Offer: the add-a-service button is gone", () => {
  it("no button, no link to the new-service page, no new tab", () => {
    expect(dialog).not.toContain("Add a new service")
    expect(dialog).not.toContain("/service-catalog/new")
    expect(dialog).not.toContain("window.open('/service-catalog")
  })

  it("the list is read the way it always was: once, while empty, with no re-read on focus", () => {
    expect(dialog).toContain("catalog.length > 0) return")
    expect(dialog).not.toMatch(/addEventListener\('focus'/)
    expect(dialog).not.toContain("selectedServicesDrift")
    expect(dialog).not.toContain("decideNewService")
  })
})

describe("service editor: who can open it, and a half-made service", () => {
  it("a non-admin who follows the link gets a plain answer, not the home screen", () => {
    expect(newPage).toContain("Only an administrator can add a service")
    expect(newPage).toContain("isAdmin(user)")
    // the admin page still loads its 'who we wait on' list (wait-kinds-wiring.test.ts)
    expect(newPage).toContain("loadWaitKinds()")
  })

  it("a new service whose later parts failed is reported with the service, and the editor opens it", () => {
    expect(actions).toContain("let created: { id: string; slug: string } | null = null")
    expect(actions.match(/service: created \?\? undefined/g)?.length).toBe(2)
    expect(editor).toContain("saveOutcome(result, mode)")
    expect(editor).toMatch(/outcome\.kind === "half_saved"/)
    expect(editor).toMatch(/router\.replace\(`\/service-catalog\/\$\{outcome\.slug\}\/edit`\)/)
  })
})
