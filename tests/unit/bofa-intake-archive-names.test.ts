import { describe, it, expect } from "vitest"
import { BOFA_PARTNER_FOLDER, BOFA_ROOT_FOLDER, BOFA_STANDALONE_FOLDER, clientFolderName, folderPath, mimeForName, nameForStoredType, safePart, storedFileName } from "@/lib/bofa-intake/archive-names"

describe("bofa intake archive naming", () => {
  it("puts a client with no partner in Standalone Applications, in a folder named with just their name", () => {
    expect(folderPath({ fullName: "Riley Parker" })).toEqual(["BofA", "Standalone Applications", "Riley Parker"])
    expect(folderPath({ partner: null, fullName: "Riley Parker" })).toEqual(["BofA", "Standalone Applications", "Riley Parker"])
  })

  it("treats an empty or blank partner as no partner", () => {
    expect(folderPath({ partner: "", fullName: "Sam Lee" })).toEqual(["BofA", "Standalone Applications", "Sam Lee"])
    expect(folderPath({ partner: "   ", fullName: "Sam Lee" })).toEqual(["BofA", "Standalone Applications", "Sam Lee"])
  })

  it("puts a partner's client in Partner > <partner name> > <client name>", () => {
    expect(folderPath({ partner: "Max Scale", fullName: "Riley Parker" })).toEqual(["BofA", "Partner", "Max Scale", "Riley Parker"])
  })

  it("never lets a slash or control character into a folder name (the store refuses them)", () => {
    expect(safePart("AC/DC\\Co\n", "x")).toBe("AC-DC-Co-")
    expect(safePart("   ", "fallback")).toBe("fallback")
    expect(safePart("..", "fallback")).toBe("fallback")
    expect(safePart("a".repeat(500), "x", 120)).toHaveLength(120)
    expect(folderPath({ partner: "A/B", fullName: "Jo\\hn" })).toEqual(["BofA", "Partner", "A-B", "Jo-hn"])
  })

  it("falls back to 'Applicant' when the name is missing", () => {
    expect(folderPath({})).toEqual(["BofA", "Standalone Applications", "Applicant"])
    expect(clientFolderName("  ")).toBe("Applicant")
  })

  it("keeps the exact folder names Antonio created", () => {
    expect(BOFA_ROOT_FOLDER).toBe("BofA")
    expect(BOFA_PARTNER_FOLDER).toBe("Partner")
    expect(BOFA_STANDALONE_FOLDER).toBe("Standalone Applications")
  })

  it("names stored files after the box they came from, keeping the extension", () => {
    expect(storedFileName("passport", "IMG 0042.PDF")).toBe("Passport photo page.pdf")
    expect(storedFileName("lease", "scan.jpeg")).toBe("Lease agreement.jpeg")
    expect(storedFileName("other", "noext")).toBe("Anything else the bank asked for")
  })

  it("knows the mime type from the extension", () => {
    expect(mimeForName("a.PDF")).toBe("application/pdf")
    expect(mimeForName("a.heic")).toBe("image/heic")
    expect(mimeForName("a.exe")).toBe("application/octet-stream")
  })

  describe("nameForStoredType — a file is called what is really stored", () => {
    it("an iPhone photo that was stored as a JPEG is no longer called .HEIC", () => {
      expect(nameForStoredType("IMG_4521.HEIC", "image/jpeg")).toBe("IMG_4521.jpg")
      expect(nameForStoredType("IMG_4521.heif", "image/jpeg")).toBe("IMG_4521.jpg")
      // and the type that goes with that name is the JPEG one, not image/heic
      expect(mimeForName(nameForStoredType("IMG_4521.HEIC", "image/jpeg"))).toBe("image/jpeg")
    })

    it("keeps the name as it is when the conversion failed and the original HEIC is what is stored", () => {
      expect(nameForStoredType("IMG_4521.HEIC", "image/heic")).toBe("IMG_4521.HEIC")
    })

    it("leaves a name alone when its ending already matches the stored type (any letter case, any JPEG spelling)", () => {
      expect(nameForStoredType("scan.PDF", "application/pdf")).toBe("scan.PDF")
      expect(nameForStoredType("a.jpeg", "image/jpeg")).toBe("a.jpeg")
      expect(nameForStoredType("a.JPG", "image/jpeg")).toBe("a.JPG")
      expect(nameForStoredType("a.png", "image/png; charset=binary")).toBe("a.png")
    })

    it("leaves a name alone when the stored type is unknown or missing (never guesses)", () => {
      expect(nameForStoredType("IMG.HEIC", null)).toBe("IMG.HEIC")
      expect(nameForStoredType("IMG.HEIC", undefined)).toBe("IMG.HEIC")
      expect(nameForStoredType("IMG.HEIC", "")).toBe("IMG.HEIC")
      expect(nameForStoredType("IMG.HEIC", "application/octet-stream")).toBe("IMG.HEIC")
    })

    it("only swaps a known ending; any other last piece stays and the right ending is added", () => {
      expect(nameForStoredType("passport.final", "image/jpeg")).toBe("passport.final.jpg")
      expect(nameForStoredType("passport", "image/jpeg")).toBe("passport.jpg")
      expect(nameForStoredType("my.photo.HEIC", "image/jpeg")).toBe("my.photo.jpg")
    })
  })
})
