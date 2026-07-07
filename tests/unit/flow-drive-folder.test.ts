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

import { extractDriveFolderId, resolveContactLinkedDriveFolder } from "@/lib/flows/flow-drive-folder"

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
