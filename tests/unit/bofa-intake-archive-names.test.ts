import { describe, it, expect } from "vitest"
import { BOFA_PARTNER_FOLDER, BOFA_ROOT_FOLDER, BOFA_STANDALONE_FOLDER, clientFolderName, folderPath, mimeForName, safePart, storedFileName } from "@/lib/bofa-intake/archive-names"

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
})
