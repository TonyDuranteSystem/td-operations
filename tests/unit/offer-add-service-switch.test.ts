import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { ADD_SERVICE_KEY, parseAddServiceSwitch } from "@/lib/offers/add-service-switch"

describe("parseAddServiceSwitch — on only when a stored true came back", () => {
  it("is on for a successful reply carrying the boolean true", () => {
    expect(parseAddServiceSwitch(true, { key: ADD_SERVICE_KEY, value: true, updated_at: "2026-11-04T00:00:00Z" })).toBe(true)
  })

  it("is off when the switch was never saved (the route answers value: null)", () => {
    expect(parseAddServiceSwitch(true, { value: null })).toBe(false)
  })

  it("is off when it was saved as false", () => {
    expect(parseAddServiceSwitch(true, { value: false })).toBe(false)
  })

  it("is off for anything that merely looks true", () => {
    expect(parseAddServiceSwitch(true, { value: "true" })).toBe(false)
    expect(parseAddServiceSwitch(true, { value: 1 })).toBe(false)
    expect(parseAddServiceSwitch(true, { value: { enabled: true } })).toBe(false)
    expect(parseAddServiceSwitch(true, { value: [true] })).toBe(false)
  })

  it("is off when the reply failed, even if the body says true", () => {
    expect(parseAddServiceSwitch(false, { value: true })).toBe(false)
  })

  it("is off for a missing or unreadable body (expired login, error page)", () => {
    expect(parseAddServiceSwitch(true, null)).toBe(false)
    expect(parseAddServiceSwitch(true, undefined)).toBe(false)
    expect(parseAddServiceSwitch(true, "<html>Sign in</html>")).toBe(false)
    expect(parseAddServiceSwitch(true, {})).toBe(false)
  })
})

/**
 * The screens must keep the promise: OFF = the dialog is what it always was. The rule above is useless if the
 * dialog does not ask it, so pin that the dialog, the settings list and the Maintenance panel are wired to it.
 */
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("add-a-service switch: wiring", () => {
  const dialog = strip(read("components/offers/create-offer-dialog.tsx"))

  it("the key is a known app setting, and it has the same name everywhere", () => {
    expect(ADD_SERVICE_KEY).toBe("offer_add_service_enabled")
    expect(read("lib/settings.ts")).toContain('"offer_add_service_enabled"')
    expect(read("components/dashboard/maintenance-panel.tsx")).toContain("offer_add_service_enabled")
  })

  it("the dialog reads the switch through the checked reader and starts OFF", () => {
    expect(dialog).toContain("from '@/lib/offers/add-service-switch'")
    expect(dialog).toContain("parseAddServiceSwitch(")
    expect(dialog).toContain("const [addServiceOn, setAddServiceOn] = useState(false)")
  })

  it("the button is only drawn when the switch is on", () => {
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
