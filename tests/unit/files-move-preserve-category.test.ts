/**
 * app/api/accounts/[id]/files/move/route.ts — preserveCategory flag +
 * server-side folder-ownership check
 *
 * dev job dfc00bcf (following ece21c44): the guided-share "file this in the
 * right folder" step reuses this route to move a file after a personal
 * document's owner has just been resolved and shared. Without preserveCategory
 * this route's normal category-sync side effect would silently flip the
 * document's category away from "personal" (2), which would turn OFF
 * isUnresolvedPersonalDocument's guard for a document whose owner was in fact
 * just confirmed by a human seconds earlier — re-opening the exact hole
 * ece21c44 closed. The manual drag-and-drop / "Move to..." menu (this route's
 * original caller) must keep syncing category as before — it never passes
 * this flag.
 *
 * The folder-ownership check (bug-hunter finding, same dev job) exists
 * because the guided-share flow's targetFolderId comes from a client-side
 * fetch keyed by a document's own account_id, fired on demand per document —
 * a route-level guard, not just caller discipline, is what stops a
 * mismatched account/folder pair (a client bug now or later) from silently
 * moving one client's document into a different client's Drive folder.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { email: "luca@tonydurante.us" } } }) },
  }),
}))

let accountDriveFolderId: string | null = "root-acct-1"
// folderId -> the folder items listFolder should return for it
let folderTree: Record<string, { id: string; mimeType: string }[]> = {}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: accountDriveFolderId ? { drive_folder_id: accountDriveFolderId } : null, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table in test mock: ${table}`)
    },
  },
}))

const moveFileMock = vi.fn(async () => ({ id: "file-1", name: "passport.pdf" }))
const listFolderMock = vi.fn(async (folderId: string) => ({ files: folderTree[folderId] || [] }))
vi.mock("@/lib/google-drive", () => ({
  moveFile: (...a: unknown[]) => moveFileMock(...a),
  listFolder: (...a: [string, number?]) => listFolderMock(...a),
}))

const updateDocumentMock = vi.fn(async () => ({ success: true, outcome: "updated" }))
vi.mock("@/lib/operations/document", () => ({
  updateDocument: (...a: unknown[]) => updateDocumentMock(...a),
}))

import { POST } from "@/app/api/accounts/[id]/files/move/route"

function req(body: Record<string, unknown>) {
  return new Request("https://x/api/accounts/acct-1/files/move", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as import("next/server").NextRequest
}

function ctx() {
  return { params: Promise.resolve({ id: "acct-1" }) }
}

const FOLDER = (id: string) => ({ id, mimeType: "application/vnd.google-apps.folder" })

beforeEach(() => {
  moveFileMock.mockClear()
  listFolderMock.mockClear()
  updateDocumentMock.mockClear()
  accountDriveFolderId = "root-acct-1"
  // Default tree: root has "folder-1", "folder-2", "folder-3" as direct
  // children, each with no subfolders — covers the existing preserveCategory
  // tests without every one needing its own bespoke tree.
  folderTree = {
    "root-acct-1": [FOLDER("folder-1"), FOLDER("folder-2"), FOLDER("folder-3")],
    "folder-1": [],
    "folder-2": [],
    "folder-3": [],
  }
})

describe("POST /api/accounts/[id]/files/move — preserveCategory", () => {
  it("skips the category sync when preserveCategory is set, even for a folder name that maps to a category", async () => {
    const res = await POST(req({ fileId: "f1", targetFolderId: "folder-1", targetFolderName: "2. Contacts", preserveCategory: true }), ctx())

    expect(res.status).toBe(200)
    expect(moveFileMock).toHaveBeenCalledWith("f1", "folder-1")
    expect(updateDocumentMock).not.toHaveBeenCalled()
  })

  it("still syncs category as before when preserveCategory is not passed (manual drag-and-drop / Move to... menu)", async () => {
    const res = await POST(req({ fileId: "f2", targetFolderId: "folder-2", targetFolderName: "2. Contacts" }), ctx())

    expect(res.status).toBe(200)
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { category: 2, category_name: "Contacts" } })
    )
  })

  it("does not attempt a category sync when preserveCategory is set and no targetFolderName is given", async () => {
    const res = await POST(req({ fileId: "f3", targetFolderId: "folder-3", preserveCategory: true }), ctx())

    expect(res.status).toBe(200)
    expect(updateDocumentMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/accounts/[id]/files/move — folder-ownership check", () => {
  it("allows moving into the account's own root folder", async () => {
    const res = await POST(req({ fileId: "f4", targetFolderId: "root-acct-1", preserveCategory: true }), ctx())

    expect(res.status).toBe(200)
    expect(moveFileMock).toHaveBeenCalledWith("f4", "root-acct-1")
  })

  it("allows moving into a one-level-deep subfolder of the account's tree", async () => {
    folderTree["folder-1"] = [FOLDER("folder-1-sub")]
    const res = await POST(req({ fileId: "f5", targetFolderId: "folder-1-sub", preserveCategory: true }), ctx())

    expect(res.status).toBe(200)
    expect(moveFileMock).toHaveBeenCalledWith("f5", "folder-1-sub")
  })

  it("rejects a targetFolderId that belongs to a different account's Drive tree, without ever calling moveFile", async () => {
    const res = await POST(req({ fileId: "f6", targetFolderId: "some-other-clients-folder", preserveCategory: true }), ctx())
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toMatch(/doesn't belong to this account/i)
    expect(moveFileMock).not.toHaveBeenCalled()
  })

  it("refuses to move anything when the account has no Drive folder linked at all", async () => {
    accountDriveFolderId = null
    const res = await POST(req({ fileId: "f7", targetFolderId: "folder-1", preserveCategory: true }), ctx())

    expect(res.status).toBe(400)
    expect(moveFileMock).not.toHaveBeenCalled()
  })
})
