/**
 * readMyFileForChat — reading ONE file of the owner's "From Claude" folder so it can be attached to a chat post (dev job f34c915d).
 * An in-memory fake of the few tables it touches; the point is WHAT IS REFUSED: another folder, a trashed or foreign file, a blocked type, a
 * size that is too big or unknown, an unverifiable drop folder, the switch being off, and the hour's budget — and that every call is audited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
let nextId = 1

function builder(table: string) {
  const filters: Array<[string, "eq" | "is" | "gte" | "neq", unknown]> = []
  let op: "select" | "insert" | "update" = "select"
  let payload: Row = {}
  let head = false
  const match = (r: Row) => filters.every(([c, k, v]) => (k === "eq" ? r[c] === v : k === "is" ? (v === null ? r[c] == null : r[c] === v) : k === "neq" ? r[c] !== v : String(r[c]) >= String(v)))
  const run = (single: boolean) => {
    const rows = (tables[table] ??= [])
    if (op === "insert") {
      const row = { id: `gen-${nextId++}`, created_at: new Date().toISOString(), ...payload }
      rows.push(row)
      return { data: row, error: null }
    }
    if (op === "update") {
      rows.filter(match).forEach((r) => Object.assign(r, payload))
      return { data: null, error: null }
    }
    const hit = rows.filter(match)
    if (head) return { count: hit.length, error: null }
    return { data: single ? hit[0] ?? null : hit, error: null }
  }
  const api: Record<string, unknown> = {
    select: (_c?: string, o?: { head?: boolean }) => { head = !!o?.head; return api },
    eq: (c: string, v: unknown) => { filters.push([c, "eq", v]); return api },
    is: (c: string, v: unknown) => { filters.push([c, "is", v]); return api },
    neq: (c: string, v: unknown) => { filters.push([c, "neq", v]); return api },
    gte: (c: string, v: unknown) => { filters.push([c, "gte", v]); return api },
    order: () => api,
    limit: () => api,
    insert: (row: Row) => { op = "insert"; payload = row; return api },
    update: (row: Row) => { op = "update"; payload = row; return api },
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run(false)).then(res, rej),
  }
  return api
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))
vi.mock("@/lib/crm-store/structure", () => ({
  ownersAreaUserId: async () => "u1",
  effectiveKind: async (id: string) => (id === "shared" ? "staff_share" : "private_root"),
  isLockedFolder: () => false,
}))
const readFileForStaff = vi.fn()
vi.mock("@/lib/crm-store/browse", () => ({ readFileForStaff: (...a: unknown[]) => readFileForStaff(...a) }))

import { readMyFileForChat } from "@/lib/crm-store/my-files-access"
import { MY_FILES_CHAT_MAX_BYTES } from "@/lib/team/attach-from-my-files-rules"

const caller = { method: "static", email: "antonio.durante@tonydurante.us" }
const F = (n: number) => `0f8fad5b-d9cb-469f-a165-7086772895${String(n).padStart(2, "0")}`
const folder = (id: string, parent: string | null, extra: Row = {}) => ({ id, name: id, kind: "custom", parent_id: parent, template_slug: null, owner_id: "own1", trashed_at: null, ...extra })
const file = (n: number, folderId: string, name: string, size: number | null, mime: string | null, extra: Row = {}) => ({
  id: F(n), name, owner_id: "own1", folder_id: folderId, state: "live", caller_key: null, store_file_versions: { size_bytes: size, mime_type: mime }, ...extra,
})

function seed() {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.store_owners = [{ id: "own1", kind: "private", private_user_id: "u1" }]
  tables.store_folders = [
    folder("root", null, { kind: "private_root", name: "My files" }),
    folder("drop", "root", { name: "From Claude" }),
    folder("sub", "drop", { name: "Mockups" }),
    folder("deep", "sub", { name: "2026" }),
    folder("other", "root", { name: "Plans" }),
    folder("foreignfolder", "root", { owner_id: "own2" }),
  ]
  tables.app_settings = [{ key: "my_files_drop_folder_id", value: "drop" }]
  tables.action_log = []
  tables.store_files = [
    file(1, "drop", "mockup.pdf", 574673, "application/pdf"),
    file(2, "deep", "deep.png", 100, "image/png"),
    file(3, "other", "private-plan.pdf", 100, "application/pdf"),
    file(4, "drop", "trashed.pdf", 100, "application/pdf", { state: "trashed" }),
    file(5, "drop", "foreign.pdf", 100, "application/pdf", { owner_id: "own2" }),
    file(6, "drop", "page.html", 100, "text/html"),
    file(7, "drop", "huge.pdf", MY_FILES_CHAT_MAX_BYTES + 1, "application/pdf"),
    file(8, "drop", "nosize.pdf", null, "application/pdf"),
    file(9, "drop", "liar.pdf", 100, "application/pdf"),
    file(10, "drop", "empty.pdf", 0, "application/pdf"),
  ]
}
const lastAudit = () => (tables.action_log.at(-1)?.details ?? {}) as Record<string, unknown>

beforeEach(() => {
  seed()
  readFileForStaff.mockReset()
  readFileForStaff.mockImplementation(async (id: string) => ({ bytes: Buffer.from("%PDF-1.4 test"), mimeType: id === F(2) ? "image/png" : "application/pdf", name: "x" }))
  process.env.MY_FILES_ACCESS_ENABLED = "1"
})
afterEach(() => { delete process.env.MY_FILES_ACCESS_ENABLED })

describe("a file that may be attached", () => {
  it("a file in From Claude: its bytes, name, folder and type come back, and the call is audited as done", async () => {
    const r = await readMyFileForChat({ file_id: F(1) }, caller)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.name).toBe("mockup.pdf")
    expect(r.folder).toBe("From Claude")
    expect(r.mime_type).toBe("application/pdf")
    expect(r.size).toBe(13)
    expect(r.bytes.toString()).toBe("%PDF-1.4 test")
    expect(readFileForStaff).toHaveBeenCalledWith(F(1))
    expect(tables.action_log).toHaveLength(1)
    expect(tables.action_log[0]).toMatchObject({ actor: "claude.mcp", action_type: "my_files_read" })
    expect(lastAudit()).toMatchObject({ tool: "team_chat_attach", file_id: F(1), file_name: "mockup.pdf", untrusted_ai_content: true, outcome: "done" })
  })

  it("a file inside a sub-folder, at any depth, of From Claude", async () => {
    const r = await readMyFileForChat({ file_id: F(2) }, caller)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.folder).toBe("From Claude/Mockups/2026")
  })
})

describe("what is refused (nothing is read, and the refusal is audited)", () => {
  const refused = async (input: unknown, re: RegExp) => {
    const r = await readMyFileForChat(input as { file_id?: unknown }, caller)
    expect(r.ok).toBe(false)
    if (r.ok !== false) return
    expect(r.error).toMatch(re)
    expect(readFileForStaff).not.toHaveBeenCalled()
    return r
  }

  it("the switch is off", async () => {
    delete process.env.MY_FILES_ACCESS_ENABLED
    await refused({ file_id: F(1) }, /switched off/)
    expect(tables.action_log).toHaveLength(0)
  })

  it("a file in another folder of My files — only From Claude qualifies", async () => {
    await refused({ file_id: F(3) }, /is not inside the "From Claude" folder/)
    expect(lastAudit().outcome).toMatch(/^refused: /)
  })

  it("something that is not a file id", async () => {
    for (const bad of [undefined, "", "../../x", 42, "not-a-uuid"]) await refused({ file_id: bad }, /file_id must be a file id/)
  })

  it("a file id that does not exist, and a file of someone else's area (same plain answer)", async () => {
    await refused({ file_id: F(99) }, /Not found in My files/)
    await refused({ file_id: F(5) }, /Not found in My files/)
  })

  it("a file in the trash", async () => {
    await refused({ file_id: F(4) }, /in the trash/)
  })

  it("a web page, by its name or type — the link is public", async () => {
    await refused({ file_id: F(6) }, /can't be sent in chat for security reasons/)
  })

  it("a file over the cap (by its recorded size), an unknown size, and an empty file", async () => {
    await refused({ file_id: F(7) }, /too big to attach from here \(limit 20 MB\)/)
    await refused({ file_id: F(8) }, /size could not be verified/)
    await refused({ file_id: F(10) }, /is empty/)
  })

  it("a file whose real bytes are bigger than its recorded size", async () => {
    readFileForStaff.mockResolvedValueOnce({ bytes: Buffer.alloc(MY_FILES_CHAT_MAX_BYTES + 1), mimeType: "application/pdf", name: "liar.pdf" })
    const r = await readMyFileForChat({ file_id: F(9) }, caller)
    expect(r.ok).toBe(false)
    if (r.ok !== false) return
    expect(r.error).toMatch(/too big to attach from here/)
  })

  it("no From Claude folder is remembered", async () => {
    tables.app_settings = []
    await refused({ file_id: F(1) }, /There is no "From Claude" folder yet/)
  })

  it("a remembered folder that cannot be verified: trashed, someone else's, not a plain folder, or inside Shared with staff", async () => {
    for (const patch of [{ trashed_at: "2026-01-01" }, { owner_id: "own2" }, { kind: "template" }] as Row[]) {
      seed()
      Object.assign(tables.store_folders.find((f) => f.id === "drop")!, patch)
      await refused({ file_id: F(1) }, /could not be verified/)
    }
    seed()
    tables.app_settings = [{ key: "my_files_drop_folder_id", value: "shared" }]
    tables.store_folders.push(folder("shared", "root", { kind: "staff_share" }))
    await refused({ file_id: F(1) }, /could not be verified/)
  })

  it("the hour's budget of reads is used up", async () => {
    for (let i = 0; i < 300; i++) tables.action_log.push({ id: `old-${i}`, action_type: "my_files_read", created_at: new Date().toISOString() })
    await refused({ file_id: F(1) }, /./)
    expect(String(lastAudit().outcome)).toMatch(/^refused: /)
  })
})
