import { describe, it, expect, vi, beforeEach } from "vitest"

const OWNER = "11111111-1111-4111-8111-111111111111"
const PARENT = "22222222-2222-4222-8222-222222222222"
const MADE = "33333333-3333-4333-8333-333333333333"

const state = vi.hoisted(() => ({
  existing: null as string | null,
  target: { ok: true } as { ok: boolean; code?: string; message?: string },
  ensure: vi.fn(),
  events: [] as Array<{ event: string; details: Record<string, unknown> }>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => { const q: Record<string, unknown> = {}; for (const m of ["select", "eq", "is"]) q[m] = () => q; q.maybeSingle = async () => ({ data: state.existing ? { id: state.existing } : null, error: null }); return q } },
}))
vi.mock("@/lib/storage-app/settings", () => ({ getSettings: async () => ({}) }))
vi.mock("@/lib/storage-app/save", () => ({ checkTarget: async () => state.target }))
vi.mock("@/lib/storage-app/device-auth", () => ({ logAppEvent: async (event: string, _a: unknown, details: Record<string, unknown>) => { state.events.push({ event, details }); return true } }))
vi.mock("@/lib/crm-store/extras", () => ({ ensureFolderPath: (...a: unknown[]) => state.ensure(...a) }))

import { createFolderFromMac } from "@/lib/storage-app/new-folder"

const user = { id: "u1" } as never
const call = (over: Record<string, unknown> = {}) => createFolderFromMac({ user, deviceId: "d1", ownerId: OWNER, parentId: PARENT, name: "2026-06-05 09.30.34 Andrea and Antonio", ...over })

beforeEach(() => { state.existing = null; state.target = { ok: true }; state.events = []; state.ensure = vi.fn(async () => ({ id: MADE, kind: "custom" })) })

describe("a Mac makes a new folder", () => {
  it("makes it, through the CRM's one folder writer, and says it was created", async () => {
    const r = await call()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ folderId: MADE, ownerId: OWNER, created: true })
    expect(state.ensure).toHaveBeenCalledWith(PARENT, ["2026-06-05 09.30.34 Andrea and Antonio"], "u1")
    expect(state.events.map((e) => e.event)).toEqual(["app_folder_created"])
  })
  it("pasting the same folder again REUSES it: same id, created false, no second audit row", async () => {
    state.existing = MADE
    const r = await call()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ folderId: MADE, created: false })
    expect(state.events).toEqual([])
  })
  it("cleans the name (extra spaces) and refuses slashes", async () => {
    expect((await call({ name: "  Zoom   Calls " })).body).toMatchObject({ name: "Zoom Calls" })
    const bad = await call({ name: "a/b" })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: "bad_name" })
  })
  it("refuses a missing / malformed request", async () => {
    expect((await call({ ownerId: "nope" })).status).toBe(400)
    expect((await call({ parentId: undefined })).status).toBe(400)
    expect((await call({ name: 5 })).status).toBe(400)
    expect(state.ensure).not.toHaveBeenCalled()
  })
  it("never makes system junk folders", async () => {
    const r = await call({ name: ".DS_Store" })
    expect(r.status).toBe(422)
    expect(state.ensure).not.toHaveBeenCalled()
  })
  it("refuses where a file could not be saved either (and writes nothing)", async () => {
    state.target = { ok: false, code: "not_allowed", message: "People's documents are added in the CRM, not from the Mac." }
    const r = await call()
    expect(r.status).toBe(422)
    expect(state.ensure).not.toHaveBeenCalled()
    expect(state.events.map((e) => e.event)).toEqual(["app_folder_refused"])
  })
  it("a folder that is not found answers 404", async () => {
    state.target = { ok: false, code: "not_found", message: "Folder not found." }
    expect((await call()).status).toBe(404)
  })
  it("a refusal from the folder writer is plain words, not a crash", async () => {
    state.ensure = vi.fn(async () => { throw new Error("Drop the folder into one of the fixed folders, not at the very top.") })
    const r = await call()
    expect(r.status).toBe(422)
    expect(String(r.body.message)).toMatch(/fixed folders/)
  })
})
