/**
 * drive_search — owner-folder gating, at the TOOL layer.
 *
 * tests/unit/owner-drive-access.test.ts proves callerIsOwner() decides correctly
 * in isolation. That is NOT the same as proving drive_search HONOURS it: the
 * tool could call the owner search unconditionally, ignore the gate, or forget
 * to call it at all, and the gate's own tests would still be green.
 *
 * These assert the wiring itself — that the owner's private accounting folder is
 * never even QUERIED for a non-owner, and that its results are never merged into
 * the client section.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpAuthContext } from "@/lib/mcp/auth-context"

const searchFiles = vi.fn()
const searchOwnerDriveFiles = vi.fn()

vi.mock("@/lib/google-drive", () => ({
  searchFiles: (...a: unknown[]) => searchFiles(...a),
  searchOwnerDriveFiles: (...a: unknown[]) => searchOwnerDriveFiles(...a),
  listFolder: vi.fn(),
  getFileMetadata: vi.fn(),
  uploadFile: vi.fn(),
  updateFileContent: vi.fn(),
  renameFile: vi.fn(),
  createFolder: vi.fn(),
  moveFile: vi.fn(),
  downloadFileContent: vi.fn(),
  uploadBinaryToDrive: vi.fn(),
  trashFile: vi.fn(),
}))
vi.mock("@/lib/gmail", () => ({ getGmailAttachment: vi.fn() }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

const CLIENT_HIT = {
  id: "c1",
  name: "bank_accounts_0_statements_CLIENT_Relay.csv",
  mimeType: "text/csv",
  modifiedTime: "2026-08-01T00:00:00Z",
  webViewLink: "https://drive.google.com/file/d/c1/view",
}
const OWNER_HIT = {
  id: "o1",
  name: "Relay 2025-01-01 #6770.csv",
  mimeType: "text/csv",
  modifiedTime: "2026-08-29T00:00:00Z",
  webViewLink: "https://drive.google.com/file/d/o1/view",
}

async function callDriveSearch(): Promise<string> {
  const { registerDriveTools } = await import("@/lib/mcp/tools/drive")
  const handlers: Record<string, (p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>> = {}
  const fakeServer = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, ..._rest: any[]) => {
      handlers[name] = _rest[_rest.length - 1]
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  registerDriveTools(fakeServer)
  const res = await handlers["drive_search"]({ query: "Relay", max_results: 25 })
  return res.content[0].text
}

beforeEach(() => {
  searchFiles.mockReset()
  searchOwnerDriveFiles.mockReset()
  searchFiles.mockResolvedValue({ files: [CLIENT_HIT] })
  searchOwnerDriveFiles.mockResolvedValue({ files: [OWNER_HIT] })
})

describe("drive_search owner-folder gating", () => {
  it("does NOT even query the owner folder for a support@ oauth caller", async () => {
    const text = await runWithMcpAuthContext(
      { method: "oauth", email: "support@tonydurante.us" },
      callDriveSearch
    )
    // The strongest assertion available: the private folder was never touched.
    expect(searchOwnerDriveFiles).not.toHaveBeenCalled()
    expect(text).not.toContain("Relay 2025-01-01")
    expect(text).not.toContain("personal accounting")
    expect(text).toContain("bank_accounts_0_statements_CLIENT_Relay.csv")
  })

  it("does NOT query the owner folder when there is no auth context", async () => {
    const text = await callDriveSearch()
    expect(searchOwnerDriveFiles).not.toHaveBeenCalled()
    expect(text).not.toContain("Relay 2025-01-01")
  })

  it("DOES include the owner folder for the owner, in a separate labelled section", async () => {
    const text = await runWithMcpAuthContext(
      { method: "oauth", email: "antonio.durante@tonydurante.us" },
      callDriveSearch
    )
    expect(searchOwnerDriveFiles).toHaveBeenCalledTimes(1)
    expect(text).toContain("Company Shared Drive")
    expect(text).toContain("personal accounting folder")
    expect(text).toContain("Relay 2025-01-01 #6770.csv")
    // Separation, not merging: the owner hit must appear AFTER the owner header,
    // never interleaved into the client list.
    expect(text.indexOf("personal accounting folder")).toBeLessThan(
      text.indexOf("Relay 2025-01-01 #6770.csv")
    )
  })

  it("includes the owner folder for the static-key (Claude Code) caller", async () => {
    await runWithMcpAuthContext({ method: "static" }, callDriveSearch)
    expect(searchOwnerDriveFiles).toHaveBeenCalledTimes(1)
  })

  it("still returns client results when the owner-folder search fails", async () => {
    // An outage on his private folder must not take down client search, which
    // every other operator depends on.
    searchOwnerDriveFiles.mockRejectedValue(new Error("owner drive unavailable"))
    const text = await runWithMcpAuthContext({ method: "static" }, callDriveSearch)
    expect(text).toContain("bank_accounts_0_statements_CLIENT_Relay.csv")
    expect(text).toContain("could not be searched")
    expect(text).toContain("owner drive unavailable")
  })
})
