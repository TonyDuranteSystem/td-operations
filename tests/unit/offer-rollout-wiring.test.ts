/**
 * The offer-builder rollout wiring (dev job d2971d11): the box "Before this offer can be sent" (Part 1) must be decided on
 * the SERVER per record (off / test accounts only / on; Claude sets it on Antonio's word), must NOT have any toggle for
 * Antonio to press, and OFF must keep the screens exactly as they always were. (The "Add a new service" button of Part 4
 * was deleted on Antonio's word, 2026-11-04: new services are set up with Claude, not in the technical editor.) The rules
 * themselves are tested in offer-rollout*.test.ts; this pins that the screens are wired to them.
 */
import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("no button for Antonio", () => {
  const panel = read("components/dashboard/maintenance-panel.tsx")

  it("the Maintenance screen has no toggle for the box, and none for the deleted add-a-service piece", () => {
    expect(panel).not.toContain("offer_add_service_enabled")
    expect(panel).not.toContain("offer_send_check_box_enabled")
    expect(panel).not.toContain("Add a new service from the offer")
    expect(panel).not.toContain("Check box beside Send")
  })

  it("the old on/off readers are gone — the screens no longer read the stored value themselves", () => {
    expect(existsSync(join(root, "lib/offers/add-service-switch.ts"))).toBe(false)
    expect(existsSync(join(root, "lib/offers/send-check-box-switch.ts"))).toBe(false)
  })

  it("the box's key is a known app setting (Claude writes it), with the three states described; the deleted piece's key is gone", () => {
    const settings = read("lib/settings.ts")
    expect(settings).toContain('"offer_send_check_box_enabled"')
    expect(settings).not.toContain('"offer_add_service_enabled"')
    expect(settings).toMatch(/"test" = test records only/)
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

  it("the Create Offer dialog itself no longer asks the rollout route (its only piece, the add-a-service button, was deleted); the box shown inside it after Save asks by offer token", () => {
    expect(dialog).not.toContain("useOfferBuilderFeatures")
    expect(dialog).not.toContain("/api/app-settings")
    expect(dialog).toContain("<OfferSendCheckBox token={createdToken} />")
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
