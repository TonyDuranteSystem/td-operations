/**
 * lib/flows/flow-drive-folder.ts — Drive-folder resolution for flow uploads.
 *
 * The contact-linked resolution exists so contact-scoped flow uploads (ITIN
 * approval letter) reach the client's company Drive folder instead of
 * silently staying in Supabase Storage (Martin Csordas, 2026-07-07).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

let linksFixture: Array<{
  account_id: string
  is_primary: boolean
  accounts: { drive_folder_id: string | null; gdrive_folder_url: string | null } | null
}> = []
let capturedOrders: Array<[string, { ascending: boolean }]> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "account_contacts") throw new Error(`unexpected table: ${table}`)
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn((col: string, opts: { ascending: boolean }) => {
          capturedOrders.push([col, opts])
          return chain
        }),
        then: (resolve: (v: { data: typeof linksFixture; error: null }) => void) =>
          resolve({ data: linksFixture, error: null }),
      }
      return chain
    },
  },
}))

import {
  extractDriveFolderId,
  resolveContactLinkedDriveFolder,
  deriveEffectiveFileName,
  resolveSubfolderId,
} from "@/lib/flows/flow-drive-folder"

const FOLDER_MIME = "application/vnd.google-apps.folder"

beforeEach(() => {
  linksFixture = []
  capturedOrders = []
})

describe("extractDriveFolderId", () => {
  it("prefers the explicit drive_folder_id", () => {
    expect(
      extractDriveFolderId({ drive_folder_id: "FOLDER123", gdrive_folder_url: "https://drive.google.com/drive/folders/OTHER" }),
    ).toBe("FOLDER123")
  })

  it("parses the folder id out of gdrive_folder_url", () => {
    expect(
      extractDriveFolderId({ drive_folder_id: null, gdrive_folder_url: "https://drive.google.com/drive/folders/1AbC-def_45?usp=sharing" }),
    ).toBe("1AbC-def_45")
  })

  it("returns null for an account with neither", () => {
    expect(extractDriveFolderId({ drive_folder_id: null, gdrive_folder_url: null })).toBeNull()
    expect(extractDriveFolderId(null)).toBeNull()
    expect(extractDriveFolderId(undefined)).toBeNull()
  })

  it("returns null for an unparseable URL", () => {
    expect(extractDriveFolderId({ drive_folder_id: null, gdrive_folder_url: "https://example.com/nope" })).toBeNull()
  })
})

describe("resolveContactLinkedDriveFolder", () => {
  it("returns the primary linked account's folder", async () => {
    linksFixture = [
      { account_id: "a1", is_primary: true, accounts: { drive_folder_id: "PRIMARY", gdrive_folder_url: null } },
      { account_id: "a2", is_primary: false, accounts: { drive_folder_id: "SECONDARY", gdrive_folder_url: null } },
    ]
    expect(await resolveContactLinkedDriveFolder("c1")).toBe("PRIMARY")
    // Ordering is the contract: is_primary DESC then account_id ASC.
    expect(capturedOrders).toEqual([
      ["is_primary", { ascending: false }],
      ["account_id", { ascending: true }],
    ])
  })

  it("skips linked accounts without a resolvable folder", async () => {
    linksFixture = [
      { account_id: "a1", is_primary: true, accounts: { drive_folder_id: null, gdrive_folder_url: null } },
      { account_id: "a2", is_primary: false, accounts: { drive_folder_id: null, gdrive_folder_url: "https://drive.google.com/drive/folders/FROMURL" } },
    ]
    expect(await resolveContactLinkedDriveFolder("c1")).toBe("FROMURL")
  })

  it("returns null when the contact has no linked accounts", async () => {
    linksFixture = []
    expect(await resolveContactLinkedDriveFolder("c1")).toBeNull()
  })

  it("tolerates PostgREST returning the joined account as an array", async () => {
    linksFixture = [
      {
        account_id: "a1",
        is_primary: true,
        accounts: [{ drive_folder_id: "ARRAYSHAPE", gdrive_folder_url: null }] as never,
      },
    ]
    expect(await resolveContactLinkedDriveFolder("c1")).toBe("ARRAYSHAPE")
  })
})

describe("deriveEffectiveFileName", () => {
  const ctx = { company_name: "Acme Holdings LLC", entity_type: "Single Member LLC" }

  it("keeps the original name when no template is given", () => {
    expect(deriveEffectiveFileName(null, "scan001.pdf", ctx)).toBe("scan001.pdf")
    expect(deriveEffectiveFileName(undefined, "scan001.pdf", ctx)).toBe("scan001.pdf")
    expect(deriveEffectiveFileName("   ", "scan001.pdf", ctx)).toBe("scan001.pdf")
  })

  it("interpolates and preserves the original extension", () => {
    expect(deriveEffectiveFileName("EIN Official – {company_name}", "cp575_scan.pdf", ctx)).toBe(
      "EIN Official – Acme Holdings LLC.pdf",
    )
  })

  it("keeps the en-dash from the template verbatim", () => {
    const out = deriveEffectiveFileName("EIN Official – {company_name}", "x.pdf", ctx)
    expect(out).toContain("–") // U+2013 en-dash, not a hyphen
    expect(out).not.toContain(" - ")
  })

  it("falls back to the original name when a token can't be resolved", () => {
    // Contact-scoped SD: no company_name in context.
    expect(deriveEffectiveFileName("EIN Official – {company_name}", "cp575.pdf", {})).toBe("cp575.pdf")
    expect(
      deriveEffectiveFileName("EIN Official – {company_name}", "cp575.pdf", { company_name: "" }),
    ).toBe("cp575.pdf")
    expect(
      deriveEffectiveFileName("EIN Official – {company_name}", "cp575.pdf", { company_name: null }),
    ).toBe("cp575.pdf")
  })

  it("adds no extension for a dotless original name", () => {
    expect(deriveEffectiveFileName("EIN Official – {company_name}", "IMG_2043", ctx)).toBe(
      "EIN Official – Acme Holdings LLC",
    )
  })

  it("treats a leading-dot dotfile as having no extension", () => {
    expect(deriveEffectiveFileName("EIN Official – {company_name}", ".hidden", ctx)).toBe(
      "EIN Official – Acme Holdings LLC",
    )
  })

  it("does not double an extension the interpolated base already ends with", () => {
    // A period inside the company name must NOT be mistaken for an extension —
    // the extension is taken from the ORIGINAL file only.
    expect(deriveEffectiveFileName("{company_name}", "letter.pdf", { company_name: "Acme Co. LLC" })).toBe(
      "Acme Co. LLC.pdf",
    )
  })
})

describe("resolveSubfolderId", () => {
  const lister = (files: Array<{ id: string; name: string; mimeType: string }>) =>
    async () => ({ files })

  it("matches a subfolder by exact name", async () => {
    const res = await resolveSubfolderId(
      "ROOT",
      "1. Company",
      lister([
        { id: "sub1", name: "1. Company", mimeType: FOLDER_MIME },
        { id: "sub2", name: "3. Tax", mimeType: FOLDER_MIME },
      ]),
    )
    expect(res).toEqual({ id: "sub1", matched: true })
  })

  it("matches case- and whitespace-insensitively (legacy folder names)", async () => {
    const res = await resolveSubfolderId(
      "ROOT",
      "1. Company",
      lister([{ id: "sub1", name: "  1. COMPANY ", mimeType: FOLDER_MIME }]),
    )
    expect(res).toEqual({ id: "sub1", matched: true })
  })

  it("ignores non-folder entries with the same name", async () => {
    const res = await resolveSubfolderId(
      "ROOT",
      "1. Company",
      lister([{ id: "file1", name: "1. Company", mimeType: "application/pdf" }]),
    )
    expect(res).toEqual({ id: null, matched: false })
  })

  it("returns matched:false when the subfolder is absent", async () => {
    const res = await resolveSubfolderId(
      "ROOT",
      "1. Company",
      lister([{ id: "sub2", name: "4. Banking", mimeType: FOLDER_MIME }]),
    )
    expect(res).toEqual({ id: null, matched: false })
  })

  it("returns matched:false (never throws) when the listing fails", async () => {
    const res = await resolveSubfolderId("ROOT", "1. Company", async () => {
      throw new Error("Drive API 500")
    })
    expect(res).toEqual({ id: null, matched: false })
  })
})
