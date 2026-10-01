import { describe, it, expect } from "vitest"
import { planDriveEntry, isDriveFolder } from "@/lib/crm-store/my-drive"

describe("planDriveEntry", () => {
  it("walks into folders", () => { expect(planDriveEntry("application/vnd.google-apps.folder", "X")).toEqual({ kind: "folder" }); expect(isDriveFolder("application/vnd.google-apps.folder")).toBe(true) })
  it("copies ordinary files as they are", () => { expect(planDriveEntry("application/pdf", "a.pdf")).toEqual({ kind: "binary", name: "a.pdf" }) })
  it("turns Google Docs / Sheets / Slides into Word / Excel / PowerPoint", () => {
    expect(planDriveEntry("application/vnd.google-apps.document", "Plan")).toMatchObject({ kind: "export", name: "Plan.docx" })
    expect(planDriveEntry("application/vnd.google-apps.spreadsheet", "Budget")).toMatchObject({ kind: "export", name: "Budget.xlsx" })
    expect(planDriveEntry("application/vnd.google-apps.presentation", "Deck.pptx")).toMatchObject({ kind: "export", name: "Deck.pptx" })
  })
  it("skips shortcuts and forms with a reason", () => {
    expect(planDriveEntry("application/vnd.google-apps.shortcut", "s")).toMatchObject({ kind: "skip" })
    expect(planDriveEntry("application/vnd.google-apps.form", "f")).toMatchObject({ kind: "skip" })
  })
})
