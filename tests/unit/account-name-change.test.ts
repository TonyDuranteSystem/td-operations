import { describe, it, expect, vi, beforeEach } from "vitest"

const rpc = vi.fn()
let selectResult: { data: unknown; error: { message: string } | null } = { data: { company_name: "Acme LLC" }, error: null }
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => selectResult }) }) }),
  },
}))

import {
  nameKey, isRealNameChange, nameEditProblem, handNameEditProblem, applyAccountNameChange, undoAccountNameChange,
  NAME_CHANGE_MESSAGE, NAME_HISTORY_MESSAGE,
} from "@/lib/operations/account-name-change"

beforeEach(() => { rpc.mockReset(); selectResult = { data: { company_name: "Acme LLC" }, error: null } })

describe("nameKey / isRealNameChange — the same call the database makes", () => {
  it("capital letters, runs of spaces and edge spaces are not a different name", () => {
    expect(nameKey("  Acme   LLC ")).toBe("acme llc")
    expect(isRealNameChange("Acme LLC", "ACME LLC")).toBe(false)
    expect(isRealNameChange("Acme LLC", "  Acme  LLC  ")).toBe(false)
    expect(isRealNameChange("Acme LLC", "Acme LLC")).toBe(false)
  })
  it("a different spelling, suffix or word is a real change", () => {
    expect(isRealNameChange("Acme LLC", "Acme Holdings LLC")).toBe(true)
    expect(isRealNameChange("Acme LLC", "Acme L.L.C.")).toBe(true)
    expect(isRealNameChange("Acme LLC", "Acmé LLC")).toBe(true)
  })
  it("a decomposed accent equals the composed one (NFC)", () => {
    expect(isRealNameChange("Café LLC", "Café LLC")).toBe(false)
  })
})

describe("nameEditProblem — what a hand edit may not do", () => {
  it("a real rename is refused with the Change Name message", () => {
    expect(nameEditProblem({ currentName: "Acme LLC", patch: { company_name: "Beta LLC" } })).toBe(NAME_CHANGE_MESSAGE)
  })
  it("a capitals/spacing fix and an unchanged name pass", () => {
    expect(nameEditProblem({ currentName: "Acme LLC", patch: { company_name: "ACME LLC" } })).toBeNull()
    expect(nameEditProblem({ currentName: "Acme LLC", patch: { company_name: "Acme LLC" } })).toBeNull()
  })
  it("previous_name and name_history can never be written by hand", () => {
    expect(nameEditProblem({ patch: { previous_name: "x" } })).toBe(NAME_HISTORY_MESSAGE)
    expect(nameEditProblem({ patch: { name_history: [] } })).toBe(NAME_HISTORY_MESSAGE)
    expect(nameEditProblem({ currentName: "Acme LLC", patch: { company_name: "Acme LLC", previous_name: null } })).toBe(NAME_HISTORY_MESSAGE)
  })
  it("a patch that does not touch the name passes without looking it up", () => {
    expect(nameEditProblem({ patch: { status: "Active", notes: "x" } })).toBeNull()
  })
  it("when the current name is unknown it cannot prove a fix is cosmetic, so it refuses; a non-string name is refused", () => {
    expect(nameEditProblem({ currentName: null, patch: { company_name: "Beta LLC" } })).toBe(NAME_CHANGE_MESSAGE)
    expect(nameEditProblem({ currentName: "Acme LLC", patch: { company_name: null } })).toBe(NAME_CHANGE_MESSAGE)
  })
})

describe("handNameEditProblem — reads the current name only when it must", () => {
  it("looks the name up and compares", async () => {
    expect(await handNameEditProblem("a1", { company_name: "Beta LLC" })).toBe(NAME_CHANGE_MESSAGE)
    expect(await handNameEditProblem("a1", { company_name: "acme llc" })).toBeNull()
  })
  it("no company_name in the patch: no lookup, no problem", async () => {
    selectResult = { data: null, error: { message: "should not be read" } }
    expect(await handNameEditProblem("a1", { notes: "x" })).toBeNull()
  })
  it("a failed lookup refuses (never lets an unproven rename through)", async () => {
    selectResult = { data: null, error: { message: "boom" } }
    expect(await handNameEditProblem("a1", { company_name: "Beta LLC" })).toMatch(/Could not check/)
  })
})

describe("applyAccountNameChange / undoAccountNameChange", () => {
  it("passes the arguments to the one database function and returns its answer", async () => {
    rpc.mockResolvedValue({ data: { status: "applied", account_id: "a1", storage: { status: "applied" } }, error: null })
    const r = await applyAccountNameChange({ accountId: "a1", changeId: "c1", newName: "Beta LLC", expectedOldName: "Acme LLC", actor: "u1" })
    expect(r.status).toBe("applied")
    expect(rpc).toHaveBeenCalledWith("store_apply_name_change_for_account", { p_account_id: "a1", p_change_id: "c1", p_new_name: "Beta LLC", p_expected_old_name: "Acme LLC", p_actor: "u1", p_dry_run: false })
  })
  it("a dry run is passed through; the actor defaults to null", async () => {
    rpc.mockResolvedValue({ data: { status: "dry_run", account_id: "a1" }, error: null })
    await applyAccountNameChange({ accountId: "a1", changeId: "c1", newName: "B", expectedOldName: "A", dryRun: true })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_dry_run: true, p_actor: null })
  })
  it("a refusal becomes a plain message (no 'store:' / 'refused —' prefix)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "store: name change refused — unexpected folder(s) directly under the top folder: \"Loose\"" } })
    await expect(applyAccountNameChange({ accountId: "a1", changeId: "c1", newName: "B", expectedOldName: "A" })).rejects.toThrow(/^unexpected folder\(s\) directly under the top folder/)
  })
  it("a conflict is an answer, not an error", async () => {
    rpc.mockResolvedValue({ data: { status: "conflict", account_id: "a1", current_name: "Other LLC" }, error: null })
    expect((await applyAccountNameChange({ accountId: "a1", changeId: "c1", newName: "B", expectedOldName: "A" })).current_name).toBe("Other LLC")
  })
  it("undo calls the undo function", async () => {
    rpc.mockResolvedValue({ data: { status: "undone", account_id: "a1" }, error: null })
    await undoAccountNameChange({ accountId: "a1", changeId: "c1" })
    expect(rpc).toHaveBeenCalledWith("store_undo_name_change_for_account", { p_account_id: "a1", p_change_id: "c1", p_actor: null, p_dry_run: false })
  })
  it("undo refusal text is plain", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "store: undo refused — the new folders already hold files or folders — the name change can no longer be undone" } })
    await expect(undoAccountNameChange({ accountId: "a1", changeId: "c1" })).rejects.toThrow(/^the new folders already hold files/)
  })
})
