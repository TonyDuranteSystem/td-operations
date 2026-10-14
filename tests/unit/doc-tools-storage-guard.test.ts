import { describe, it, expect, vi, beforeEach } from "vitest"

const state = { company: "drive" as "drive" | "moving" | "store", folderLocked: false }

vi.mock("@/lib/crm-store/switched-drive-guard", () => ({
  SwitchedCompanyDriveWriteError: class extends Error {},
  companyDocState: vi.fn(async () => state.company),
  lockedFolderIdsCached: vi.fn(async () => new Set<string>()),
  assertTargetsNotSwitched: vi.fn(async () => {
    if (state.folderLocked) {
      const { SwitchedCompanyDriveWriteError } = await import("@/lib/crm-store/switched-drive-guard")
      throw new SwitchedCompanyDriveWriteError("locked")
    }
  }),
}))
vi.mock("@/lib/google-drive", () => ({
  getFileMetadata: vi.fn(async () => { throw new Error("must not be reached for a company in storage") }),
  listFolder: vi.fn(),
  driveParentIds: vi.fn(),
}))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/mcp/tools/classify", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))

import { processFile, IN_STORAGE_MESSAGE, isInSwitchedDriveFolder, accountIsInStorage } from "@/lib/mcp/tools/doc"

describe("bulk document tools leave a company in storage alone", () => {
  beforeEach(() => { state.company = "drive"; state.folderLocked = false })

  it("processFile refuses when the company is in storage, before touching Drive", async () => {
    state.company = "store"
    const r = await processFile("drive-file", "acc-1")
    expect(r.success).toBe(false)
    expect(r.status).toBe("refused")
    expect(r.error).toBe(IN_STORAGE_MESSAGE)
  })
  it("processFile refuses while the company is mid-move", async () => {
    state.company = "moving"
    expect((await processFile("drive-file", "acc-1")).status).toBe("refused")
  })
  it("processFile refuses a file that sits in a switched company's Drive folder (no account given)", async () => {
    state.folderLocked = true
    expect((await processFile("drive-file")).status).toBe("refused")
  })
  it("a company still in Drive is not refused by the guard", async () => {
    // reaches Drive (mock throws) -> reported as an ordinary processing failure, not a refusal
    const r = await processFile("drive-file", "acc-1")
    expect(r.status).not.toBe("refused")
    expect(r.success).toBe(false)
  })
  it("helpers answer plainly", async () => {
    expect(await accountIsInStorage("a")).toBe(false)
    state.company = "store"
    expect(await accountIsInStorage("a")).toBe(true)
    state.folderLocked = true
    expect(await isInSwitchedDriveFolder("f")).toBe(true)
  })
})
