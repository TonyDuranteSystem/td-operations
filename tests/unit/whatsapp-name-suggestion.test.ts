import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  msgs: [] as Array<{ sender_name: string | null }>,
  contacts: [] as Array<Record<string, unknown>>,
  contactsError: null as { message: string } | null,
  contactQueries: [] as string[],
}))

function builder(table: string) {
  const b: Record<string, unknown> = {}
  const chain = () => b
  for (const m of ["eq", "is", "or", "order", "limit", "select"]) b[m] = chain
  b.ilike = (_c: string, pat: string) => { state.contactQueries.push(pat); return b }
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: table === "messages" ? state.msgs : state.contacts, error: table === "messages" ? null : state.contactsError }).then(ok)
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

import { findNameSuggestion } from "@/lib/messaging/name-suggestion"

const DAVIDE = { id: "c1", full_name: "Davide Biancardini", phone: "+17272509796", phone_2: null, phone_3: null, phone_4: null, account_contacts: [{ accounts: { company_name: "Ortus Agency LLC" } }] }
const JID = "393669626437@c.us"

beforeEach(() => { state.msgs = []; state.contacts = []; state.contactQueries = []; state.contactsError = null })

describe("findNameSuggestion", () => {
  it("offers the single matching client, with the numbers already on file", async () => {
    state.msgs = [{ sender_name: "Davide Biancardini" }]
    state.contacts = [DAVIDE, { id: "c2", full_name: "Davide Rossi", phone: "1", phone_2: null, phone_3: null, phone_4: null }]
    const s = await findNameSuggestion("g1", JID, null)
    expect(s).toMatchObject({ kind: "one", contact: { id: "c1", name: "Davide Biancardini", accountName: "Ortus Agency LLC", phones: ["+17272509796"], canAdd: true } })
  })
  it("reports several (text only) when two clients fit", async () => {
    state.msgs = [{ sender_name: "Davide Biancardini" }]
    state.contacts = [DAVIDE, { ...DAVIDE, id: "c3", full_name: "Biancardini Davide" }]
    expect(await findNameSuggestion("g1", JID, null)).toMatchObject({ kind: "several" })
  })
  it("offers nothing when nobody fits", async () => {
    state.msgs = [{ sender_name: "Luca Degasperi" }]
    state.contacts = [DAVIDE]
    expect(await findNameSuggestion("g1", JID, null)).toBeNull()
  })
  it("offers nothing and does not even search for a one-word name or only-junk names", async () => {
    state.msgs = [{ sender_name: "Davide" }, { sender_name: "TD Team" }]
    state.contacts = [DAVIDE]
    expect(await findNameSuggestion("g1", JID, "Tony Durante LLC")).toBeNull()
    expect(state.contactQueries).toHaveLength(0)
  })
  it("says the number cannot be added when all four slots are full", async () => {
    state.msgs = [{ sender_name: "Davide Biancardini" }]
    state.contacts = [{ ...DAVIDE, phone_2: "222", phone_3: "333", phone_4: "444" }]
    expect(await findNameSuggestion("g1", JID, null)).toMatchObject({ kind: "one", contact: { canAdd: false } })
  })
  it("also uses the chat's saved name", async () => {
    state.contacts = [DAVIDE]
    expect(await findNameSuggestion("g1", JID, "Davide Biancardini")).toMatchObject({ kind: "one" })
  })
  it("never offers a group chat", async () => {
    state.msgs = [{ sender_name: "Davide Biancardini" }]
    state.contacts = [DAVIDE]
    expect(await findNameSuggestion("g1", "120363123456789012@g.us", null)).toBeNull()
  })
  it("a cut-off candidate list is treated as several, never as one", async () => {
    state.msgs = [{ sender_name: "Davide Biancardini" }]
    state.contacts = [DAVIDE, ...Array.from({ length: 99 }, (_, i) => ({ id: `x${i}`, full_name: "Someone Else", phone: null, phone_2: null, phone_3: null, phone_4: null }))]
    expect(await findNameSuggestion("g1", JID, null)).toMatchObject({ kind: "several" })
  })
  it("fails closed: a database error is thrown, not read as 'nobody else has this name'", async () => {
    state.msgs = [{ sender_name: "Davide Biancardini" }]
    state.contactsError = { message: "timeout" }
    await expect(findNameSuggestion("g1", JID, null)).rejects.toThrow(/candidate contacts/)
  })
})
