/**
 * POST /api/inbox/whatsapp-new/add-number — staff clicked "Add this number" on the same-name suggestion.
 * The server re-decides everything, so a stale, forged or raced call cannot put a number on the wrong person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  isStaff: true,
  group: null as Record<string, unknown> | null,
  groupAfter: null as Record<string, unknown> | null,
  contact: null as Record<string, unknown> | null,
  freshContact: null as Record<string, unknown> | null,
  others: [] as Array<Record<string, unknown>>,
  leads: [] as Array<Record<string, unknown>>,
  othersError: null as { message: string } | null,
  linkRows: [{ id: "g1" }] as Array<{ id: string }>,
  slotWrites: [] as Array<Record<string, unknown>>,
  slotWriteResults: [] as Array<Array<{ id: string }>>, // one entry per attempt
  groupUpdates: [] as Array<Record<string, unknown>>,
  singleGroupCalls: 0,
  suggestion: null as unknown,
  suggestionThrows: false,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.isStaff ? { id: "u1" } : null } }) } }),
}))
vi.mock("@/lib/auth", () => ({ isDashboardUser: (u: unknown) => !!u && state.isStaff }))
vi.mock("@/lib/messaging/name-suggestion", () => ({
  findNameSuggestion: async () => {
    if (state.suggestionThrows) throw new Error("db down")
    return state.suggestion
  },
}))

function builder(table: string) {
  let op: "select" | "update" = "select"
  let payload: Record<string, unknown> | null = null
  let isSingle = false
  const b: Record<string, unknown> = {}
  const chain = () => b
  for (const m of ["eq", "neq", "is", "or", "order", "limit", "ilike"]) b[m] = chain
  b.select = () => b
  b.update = (p: Record<string, unknown>) => { op = "update"; payload = p; return b }
  const resolve = () => {
    if (table === "messaging_groups") {
      if (op === "update") { state.groupUpdates.push(payload!); return { data: state.linkRows, error: null } }
      state.singleGroupCalls++
      return { data: state.singleGroupCalls === 1 ? state.group : state.groupAfter ?? state.group, error: null }
    }
    if (table === "leads") return { data: state.leads, error: null }
    // contacts
    if (op === "update") { state.slotWrites.push(payload!); return { data: state.slotWriteResults.shift() ?? [{ id: "c1" }], error: null } }
    if (isSingle) return { data: state.slotWrites.length ? state.freshContact : state.contact, error: null }
    return { data: state.others, error: state.othersError }
  }
  b.single = async () => { isSingle = true; return resolve() }
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve(resolve()).then(ok)
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

import { POST } from "@/app/api/inbox/whatsapp-new/add-number/route"

const post = (body: unknown) => POST({ json: async () => body } as never)
const GROUP = { id: "g1", external_group_id: "393669626437@c.us", group_name: null, lead_id: null, contact_id: null, account_id: null }
const DAVIDE = { id: "c1", full_name: "Davide Biancardini", phone: "+17272509796", phone_2: null, phone_3: null, phone_4: null, merged_into: null, is_test: false }
const ONE = { kind: "one", contact: { id: "c1", name: "Davide Biancardini", accountName: null, phones: ["+17272509796"], canAdd: true } }
const ok = () => post({ groupId: "g1", contactId: "c1" })

beforeEach(() => {
  state.isStaff = true
  state.group = { ...GROUP }
  state.groupAfter = null
  state.contact = { ...DAVIDE }
  state.freshContact = { ...DAVIDE, phone_2: "+39taken" }
  state.others = []
  state.leads = []
  state.othersError = null
  state.linkRows = [{ id: "g1" }]
  state.slotWrites = []
  state.slotWriteResults = []
  state.groupUpdates = []
  state.singleGroupCalls = 0
  state.suggestion = ONE
  state.suggestionThrows = false
})

describe("add-number", () => {
  it("is staff-only", async () => {
    state.isStaff = false
    expect((await ok()).status).toBe(403)
    expect(state.slotWrites).toHaveLength(0)
  })
  it("needs both ids", async () => {
    expect((await post({ groupId: "g1" })).status).toBe(400)
  })
  it("links the chat, then writes the number into the first free slot", async () => {
    const res = await ok()
    expect(res.status).toBe(200)
    expect(state.groupUpdates[0]).toMatchObject({ contact_id: "c1" })
    expect(state.slotWrites).toEqual([{ phone_2: "+393669626437" }])
    expect((await res.json()).numberAdded).toBe(true)
  })
  it("only links when the number is already on the contact", async () => {
    state.contact = { ...DAVIDE, phone_3: "+39 366 962 6437" }
    const res = await ok()
    expect(res.status).toBe(200)
    expect(state.slotWrites).toHaveLength(0)
    expect((await res.json()).numberAdded).toBe(false)
  })
  it("refuses a chat that is already linked, changing nothing", async () => {
    state.group = { ...GROUP, contact_id: "someone" }
    expect((await ok()).status).toBe(409)
    expect(state.groupUpdates).toHaveLength(0)
  })
  it("refuses a group chat or linked-id key", async () => {
    state.group = { ...GROUP, external_group_id: "120363123456789012@g.us" }
    expect((await ok()).status).toBe(400)
    state.group = { ...GROUP, external_group_id: "99999999999@lid" }
    expect((await ok()).status).toBe(400)
  })
  it("refuses when it is no longer exactly this one client (second same-name client, no match, other id)", async () => {
    state.suggestion = { kind: "several", names: ["A B", "A B"] }
    expect((await ok()).status).toBe(409)
    state.suggestion = null
    expect((await ok()).status).toBe(409)
    state.suggestion = { ...ONE, contact: { ...ONE.contact, id: "other" } }
    expect((await ok()).status).toBe(409)
    expect(state.groupUpdates).toHaveLength(0)
  })
  it("fails closed when the match double-check cannot run", async () => {
    state.suggestionThrows = true
    const res = await ok()
    expect(res.status).toBe(500)
    expect(state.groupUpdates).toHaveLength(0)
  })
  it("refuses a merged or test contact", async () => {
    state.contact = { ...DAVIDE, merged_into: "other" }
    expect((await ok()).status).toBe(404)
    state.contact = { ...DAVIDE, is_test: true }
    expect((await ok()).status).toBe(404)
  })
  it("refuses when a different contact has the number, even in a formatted shape", async () => {
    state.others = [{ id: "c9", phone: "+39 366 962 6437", phone_2: null, phone_3: null, phone_4: null }]
    expect((await ok()).status).toBe(409)
    state.others = [{ id: "c9", phone: "(39) 366-962-6437", phone_2: null, phone_3: null, phone_4: null }]
    expect((await ok()).status).toBe(409)
    expect(state.groupUpdates).toHaveLength(0)
  })
  it("refuses when a lead has the number", async () => {
    state.leads = [{ id: "l1", phone: "+39 366 962 6437" }]
    expect((await ok()).status).toBe(409)
    expect(state.groupUpdates).toHaveLength(0)
  })
  it("fails closed when the clash lookup errors", async () => {
    state.othersError = { message: "timeout" }
    const res = await ok()
    expect(res.status).toBe(500)
    expect(state.groupUpdates).toHaveLength(0)
  })
  it("refuses when all four slots are taken", async () => {
    state.contact = { ...DAVIDE, phone_2: "2222222", phone_3: "3333333", phone_4: "4444444" }
    const res = await ok()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/four phone numbers/)
  })
  it("treats a free-text slot as taken (never overwrites a note)", async () => {
    state.contact = { ...DAVIDE, phone_2: "ask Maria" }
    await ok()
    expect(state.slotWrites).toEqual([{ phone_3: "+393669626437" }])
  })
  it("a chat linked to someone else in the meantime changes nothing", async () => {
    state.linkRows = []
    state.groupAfter = { contact_id: "someone-else" }
    const res = await ok()
    expect(res.status).toBe(409)
    expect(state.slotWrites).toHaveLength(0)
  })
  it("a chat the auto-linker just linked to THIS client is fine, and the number is still saved", async () => {
    state.linkRows = []
    state.groupAfter = { contact_id: "c1" }
    expect((await ok()).status).toBe(200)
    expect(state.slotWrites).toHaveLength(1)
  })
  it("when the slot was taken by another click, tries the next free slot", async () => {
    state.slotWriteResults = [[], [{ id: "c1" }]] // first write matched no row (slot taken), second succeeds
    const res = await ok()
    expect(res.status).toBe(200)
    expect(state.slotWrites.map((w) => Object.keys(w)[0])).toEqual(["phone_2", "phone_3"])
  })
  it("undoes the link when the number cannot be saved", async () => {
    state.slotWriteResults = [[], [], [], []]
    const res = await ok()
    expect(res.status).toBe(409)
    expect(state.groupUpdates.some((u) => u.contact_id === null)).toBe(true)
  })
})
