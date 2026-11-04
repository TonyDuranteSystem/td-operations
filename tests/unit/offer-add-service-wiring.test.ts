import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * "Add a new service from the offer" (flexible-offer track, part 4): the screens must keep their promises.
 * The rules themselves are tested in offer-catalog-refresh.test.ts and service-save-outcome.test.ts; this pins
 * that the screens actually use them (a rule nobody calls protects nobody).
 */
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

const dialog = strip(read("components/offers/create-offer-dialog.tsx"))
const newPage = strip(read("app/(dashboard)/service-catalog/new/page.tsx"))
const editor = strip(read("app/(dashboard)/service-catalog/service-edit-client.tsx"))
const actions = strip(read("app/(dashboard)/service-catalog/actions.ts"))

describe("offer builder: the service list stays current", () => {
  it("reads the list through the checked reader, and never turns a bad reply into an empty list", () => {
    expect(dialog).toContain("from '@/lib/offers/catalog-refresh'")
    expect(dialog).toContain("parseServiceCatalogReply(")
    // the old shape: fetch once, only while the list is empty, and read whatever came back as the list
    expect(dialog).not.toContain("catalog.length > 0) return")
    expect(dialog).not.toMatch(/d\.services \?\? \[\]/)
  })

  it("reads the list again when the dialog opens and when this window is used again", () => {
    expect(dialog).toMatch(/addEventListener\('focus'/)
    expect(dialog).toMatch(/addEventListener\('visibilitychange'/)
    expect(dialog).toMatch(/removeEventListener\('focus'/)
  })

  it("an older answer never overwrites a newer one", () => {
    expect(dialog).toMatch(/seq === catalogSeq\.current/)
  })

  it("the draft is not saved on a list that went stale: the check runs before the services are built", () => {
    const check = dialog.indexOf("selectedServicesDrift(")
    const build = dialog.indexOf("const servicesJson = selected")
    expect(check).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(check)
  })
})

describe("offer builder: Add a new service", () => {
  it("has the button, and it opens the full service editor in a new tab", () => {
    expect(dialog).toContain("Add a new service")
    expect(dialog).toContain("window.open('/service-catalog/new', '_blank', 'noopener')")
  })

  it("ticks the new service by what is new on the list (never by name), once", () => {
    expect(dialog).toContain("decideNewService(")
    expect(dialog).toContain("pendingNewService.current = null")
    // adding to the ticked list must not toggle: a second refresh must not untick it
    expect(dialog).toMatch(/prev\.some\(s => s\.id === svc\.id\) \? prev :/)
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
