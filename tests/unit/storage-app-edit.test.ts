import { describe, it, expect, vi, beforeEach } from "vitest"

const ITEM = "11111111-1111-4111-8111-111111111111"
const OWNER = "22222222-2222-4222-8222-222222222222"
const PLACE = "33333333-3333-4333-8333-333333333333"
const DEST = "44444444-4444-4444-8444-444444444444"

const st = vi.hoisted(() => ({
  file: { id: "", owner_id: "", folder_id: "", name: "a.pdf", state: "live" } as Record<string, unknown> | null,
  folder: null as Record<string, unknown> | null,
  ownerKind: "business",
  target: vi.fn(),
  calls: [] as string[],
  events: [] as string[],
  libError: null as string | null,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => { const q: Record<string, unknown> = {}; for (const m of ["select", "eq"]) q[m] = () => q
    q.maybeSingle = async () => ({ data: t === "store_files" ? st.file : t === "store_folders" ? st.folder : t === "store_owners" ? { kind: st.ownerKind } : null, error: null }); return q } },
}))
vi.mock("@/lib/storage-app/settings", () => ({ getSettings: async () => ({}) }))
vi.mock("@/lib/storage-app/save", () => ({ checkTarget: (...a: unknown[]) => st.target(...a) }))
vi.mock("@/lib/storage-app/device-auth", () => ({ logAppEvent: async (e: string) => { st.events.push(e); return true } }))
const lib = (name: string) => async (...a: unknown[]) => { st.calls.push(`${name}:${a.slice(0, 2).join(",")}`); if (st.libError) throw new Error(st.libError); return { name: "new name", folderName: "x" } }
vi.mock("@/lib/crm-store/file-actions", () => ({ renameStoreFile: lib("renameFile"), moveStoreFile: lib("moveFile") }))
vi.mock("@/lib/crm-store/structure", () => ({ renameFolder: lib("renameFolder"), moveFolder: lib("moveFolder") }))
vi.mock("@/lib/crm-store/folders", () => ({ trashFile: lib("trashFile"), trashFolder: lib("trashFolder") }))

import { editFromMac } from "@/lib/storage-app/edit"

const user = { id: "u1", app_metadata: { role: "admin" } } as never
const run = (over: Record<string, unknown> = {}) => editFromMac({ user, deviceId: "d1", kind: "file", id: ITEM, action: "rename", name: "new name", ...over })

beforeEach(() => {
  st.file = { id: ITEM, owner_id: OWNER, folder_id: PLACE, name: "a.pdf", state: "live" }
  st.folder = { id: ITEM, owner_id: OWNER, parent_id: PLACE, name: "Zoom", kind: "custom", template_slug: null, trashed_at: null }
  st.ownerKind = "business"; st.calls = []; st.events = []; st.libError = null
  st.target = vi.fn(async () => ({ ok: true }))
})

describe("a Mac renames, moves or trashes something that exists", () => {
  it("renames a file and a folder through the CRM's own functions", async () => {
    expect((await run()).body).toMatchObject({ id: ITEM, kind: "file", name: "new name", parentId: PLACE })
    expect((await run({ kind: "folder" })).status).toBe(200)
    expect(st.calls).toEqual([`renameFile:${ITEM},new name`, `renameFolder:${ITEM},new name`])
    expect(st.events).toEqual(["app_item_rename", "app_item_rename"])
  })
  it("moves only to a place a Mac may save into, and checks BOTH places", async () => {
    const r = await run({ action: "move", toParentId: DEST })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ parentId: DEST })
    expect(st.target).toHaveBeenCalledTimes(2)
    expect(st.calls).toEqual([`moveFile:${ITEM},${DEST}`])
  })
  it("a move to a place that is not allowed writes nothing", async () => {
    st.target = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, code: "not_allowed", message: "People's documents are added in the CRM, not from the Mac." })
    const r = await run({ action: "move", toParentId: DEST })
    expect(r.status).toBe(422)
    expect(st.calls).toEqual([])
    expect(st.events).toEqual(["app_edit_refused"])
  })
  it("trash goes to the CRM trash (file and folder)", async () => {
    expect((await run({ action: "trash" })).body).toMatchObject({ trashed: true })
    expect((await run({ action: "trash", kind: "folder" })).status).toBe(200)
    expect(st.calls.map((c) => c.split(":")[0])).toEqual(["trashFile", "trashFolder"])
  })
  it("a client's folders are changed in the CRM, never from the Mac", async () => {
    for (const k of ["company", "person", "formation"]) { st.ownerKind = k; const r = await run(); expect(r.status).toBe(422); expect(String(r.body.message)).toMatch(/CRM/) }
    expect(st.calls).toEqual([])
  })
  it("a fixed (template) folder is never touched", async () => {
    st.folder = { ...(st.folder as object), template_slug: "tax" }
    const r = await run({ kind: "folder", action: "trash" })
    expect(r.status).toBe(422)
    expect(String(r.body.message)).toMatch(/fixed folders/)
    expect(st.calls).toEqual([])
  })
  it("refuses where the place is not one a Mac may save into (top, Contacts, Shared with staff)", async () => {
    st.target = vi.fn(async () => ({ ok: false, code: "not_allowed", message: "\"Shared with staff\" is managed in the CRM." }))
    expect((await run()).status).toBe(422)
    expect(st.calls).toEqual([])
  })
  it("the CRM's own refusal comes back in plain words (taken name, locked file …)", async () => {
    st.libError = "A file with this name is already in this folder."
    const r = await run()
    expect(r.status).toBe(422)
    expect(r.body.message).toBe("A file with this name is already in this folder.")
  })
  it("a missing or trashed item is a 404; a bad request is a 400", async () => {
    st.file = { ...(st.file as object), state: "trashed" }
    expect((await run()).status).toBe(404)
    st.file = null
    expect((await run()).status).toBe(404)
    expect((await run({ id: "nope" })).status).toBe(400)
    expect((await run({ action: "erase" })).status).toBe(400)
    expect((await run({ name: undefined })).status).toBe(400)
    expect((await run({ action: "move", toParentId: "x" })).status).toBe(400)
    expect((await run({ kind: "thing" })).status).toBe(400)
  })
  it("a folder with no parent (a storage's top) is refused", async () => {
    st.folder = { ...(st.folder as object), parent_id: null }
    expect((await run({ kind: "folder" })).status).toBe(422)
  })
})
