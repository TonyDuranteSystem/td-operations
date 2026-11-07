/**
 * TD Social phone app — Apple's privacy manifest (App Store submission, dev job 2072bc3e, 6 Nov 2026).
 * The app stores two small things with UserDefaults, which Apple calls a "required reason" use; a build without the file's declaration can be refused at
 * submission. Pinned here: the file exists in the app folder, says "no tracking", declares exactly the UserDefaults reason CA92.1, and the project
 * generator puts it in the app's resources (so it lands at the root of the app, where Apple looks).
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const manifestPath = "ios/TDSocial/App/PrivacyInfo.xcprivacy"

describe("PrivacyInfo.xcprivacy", () => {
  it("exists, with exactly that name, in the app folder", () => {
    expect(existsSync(join(root, manifestPath))).toBe(true)
  })

  it("says the app does not track and names no tracking domain", () => {
    const m = read(manifestPath)
    expect(m).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/)
    expect(m).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/)
  })

  it("declares the UserDefaults category with the reason 'information only the app itself reads' (CA92.1), and nothing else", () => {
    const m = read(manifestPath)
    expect(m).toContain("NSPrivacyAccessedAPICategoryUserDefaults")
    expect(m).toContain("<string>CA92.1</string>")
    expect((m.match(/NSPrivacyAccessedAPICategory[A-Za-z]+/g) ?? []).length).toBe(1)
  })

  it("matches what the app really uses: UserDefaults only, none of the other required-reason areas", () => {
    const code = ["AppModel.swift", "API.swift", "FileOpener.swift", "WebHost.swift", "Views.swift", "TDSocialApp.swift"].map(f => read(`ios/TDSocial/App/${f}`)).join("\n")
    expect(code).toContain("UserDefaults.standard")
    for (const other of ["contentModificationDateKey", "creationDateKey", "volumeAvailableCapacity", "systemUptime", "attributesOfItem", "activeInputModes"]) {
      expect(code, other).not.toContain(other)
    }
  })

  it("the project generator copies it into the app's resources", () => {
    const gen = read("ios/TDSocial/generate_xcodeproj.rb")
    expect(gen).toContain("app_group.new_reference('PrivacyInfo.xcprivacy')")
    expect(gen).toContain("app.resources_build_phase.add_file_reference(privacy, true)")
  })
})
