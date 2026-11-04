/**
 * The offer-builder rollout wiring (dev job d2971d11): the new pieces — "Add a new service" in Create Offer (Part 4) and
 * the box "Before this offer can be sent" (Part 1) — must be decided on the SERVER per record (off / test accounts only /
 * on; Claude sets it on Antonio's word), must NOT have any toggle for Antonio to press, and OFF must keep the screens
 * exactly as they always were. The rules themselves are tested in offer-rollout*.test.ts; this pins that the screens
 * are wired to them.
 */
import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("no button for Antonio", () => {
  const panel = read("components/dashboard/maintenance-panel.tsx")

  it("the Maintenance screen has no toggle for either piece", () => {
    expect(panel).not.toContain("offer_add_service_enabled")
    expect(panel).not.toContain("offer_send_check_box_enabled")
    expect(panel).not.toContain("Add a new service from the offer")
    expect(panel).not.toContain("Check box beside Send")
  })

  it("the two old on/off readers are gone — the screens no longer read the stored value themselves", () => {
    expect(existsSync(join(root, "lib/offers/add-service-switch.ts"))).toBe(false)
    expect(existsSync(join(root, "lib/offers/send-check-box-switch.ts"))).toBe(false)
  })

  it("both keys are still known app settings (Claude writes them), with the three states described", () => {
    const settings = read("lib/settings.ts")
    expect(settings).toContain('"offer_add_service_enabled"')
    expect(settings).toContain('"offer_send_check_box_enabled"')
    expect(settings).toMatch(/"test" = only on records marked is_test/)
  })
})

describe("the screens ask the server, per record", () => {
  const hook = strip(read("components/offers/use-offer-builder-features.ts"))
  const dialog = strip(read("components/offers/create-offer-dialog.tsx"))
  const box = strip(read("components/offers/offer-send-check-box.tsx"))

  it("the helper asks the staff route, starts hidden, and ties each answer to the record it was asked about", () => {
    expect(hook).toContain("/api/crm/admin-actions/offer-builder-features?")
    expect(hook).toContain("parseFeaturesReply(")
    expect(hook).toContain("answer && answer.key === key ? answer.features : NO_FEATURES")
    expect(hook).toContain("if (!enabled) return")
    expect(hook).not.toContain("/api/app-settings")
  })

  it("Create Offer asks with the ids it was opened for, only while open, and no longer reads app-settings itself", () => {
    expect(dialog).toContain("from './use-offer-builder-features'")
    expect(dialog).toContain("const { addService: addServiceOn } = useOfferBuilderFeatures({ leadId, accountId, contactId }, open)")
    expect(dialog).not.toContain("/api/app-settings")
    expect(dialog).not.toContain("parseAddServiceSwitch")
    expect(dialog).not.toContain("setAddServiceOn")
  })

  it("the box asks with its offer's token and draws nothing until the server says yes", () => {
    expect(box).toContain("from './use-offer-builder-features'")
    expect(box).toContain("const { sendCheckBox: on } = useOfferBuilderFeatures({ token })")
    expect(box).not.toContain("/api/app-settings")
    expect(box).not.toContain("parseSendCheckBoxSwitch")
    expect(box).toContain("if (!on) return null")
    expect(box).toMatch(/if \(on\) void run\(\)/)
  })
})

describe("Create Offer: OFF keeps the dialog exactly as it always was", () => {
  const dialog = strip(read("components/offers/create-offer-dialog.tsx"))

  it("the last answer is kept in a ref the list-loading effect reads (so a reopened window does not blink)", () => {
    expect(dialog).toContain("const addServiceOnRef = useRef(false)")
    expect(dialog).toMatch(/addServiceOnRef\.current = addServiceOn/)
  })

  it("the button is only drawn when the piece is on", () => {
    const start = dialog.indexOf("{addServiceOn && (")
    const button = dialog.indexOf("Add a new service")
    expect(start).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(start)
  })

  it("OFF keeps the old list loading: read once, never again on its own", () => {
    expect(dialog).toContain("if (!addServiceOnRef.current && hasCatalog.current) return")
    expect(dialog).toMatch(/if \(!open \|\| !addServiceOn\) return/)
  })

  it("OFF skips the re-read and the changed-service check before saving", () => {
    const gate = dialog.indexOf("addServiceOn ? await loadCatalog(")
    const check = dialog.indexOf("selectedServicesDrift(")
    const build = dialog.indexOf("const servicesJson = selected")
    expect(gate).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(gate)
    expect(build).toBeGreaterThan(check)
  })
})
