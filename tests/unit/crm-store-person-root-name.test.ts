import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  contact: { full_name: "Chiara Vita" } as { full_name: string | null } | null,
  owners: [{ id: "o1" }] as Array<{ id: string }>,
  renamed: true as boolean,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcError: null as { message: string } | null,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: table === "contacts" ? state.contact : null, error: null })
      chain.limit = async () => ({ data: table === "store_owners" ? state.owners : [], error: null })
      return chain
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args })
      return { data: state.renamed, error: state.rpcError }
    },
  },
}))

import { personRootNameFor, syncPersonRootName, findRootMismatches } from "@/lib/crm-store/person-root-name"

beforeEach(() => {
  state.contact = { full_name: "Chiara Vita" }
  state.owners = [{ id: "o1" }]
  state.renamed = true
  state.rpcCalls = []
  state.rpcError = null
})

describe("personRootNameFor", () => {
  it("uses the real name, made safe for a folder", () => {
    expect(personRootNameFor("  Chiara   Vita ")).toBe("Chiara Vita")
    expect(personRootNameFor("A/B Rossi")).toBe("A-B Rossi")
  })
  it("never turns a blank or placeholder name into a folder name", () => {
    expect(personRootNameFor(null)).toBeNull()
    expect(personRootNameFor("   ")).toBeNull()
    expect(personRootNameFor("Client")).toBeNull()
    expect(personRootNameFor("new client")).toBeNull()
  })
})

describe("syncPersonRootName", () => {
  it("renames the person's top folder to the contact's current name", async () => {
    const r = await syncPersonRootName("c1")
    expect(r).toEqual({ status: "renamed", ownerId: "o1", name: "Chiara Vita" })
    expect(state.rpcCalls).toEqual([{ fn: "store_rename_root", args: { p_owner_id: "o1", p_name: "Chiara Vita", p_actor: null } }])
  })
  it("reports unchanged when the folder already has that name", async () => {
    state.renamed = false
    expect((await syncPersonRootName("c1")).status).toBe("unchanged")
  })
  it("does nothing for a person with no live storage", async () => {
    state.owners = []
    expect(await syncPersonRootName("c1")).toEqual({ status: "skipped", reason: "no_storage" })
    expect(state.rpcCalls).toHaveLength(0)
  })
  it("does nothing for a missing contact or a blank name", async () => {
    state.contact = null
    expect(await syncPersonRootName("c1")).toEqual({ status: "skipped", reason: "no_contact" })
    state.contact = { full_name: " " }
    expect(await syncPersonRootName("c1")).toEqual({ status: "skipped", reason: "no_name" })
    expect(state.rpcCalls).toHaveLength(0)
  })
  it("never throws: a database error comes back as failed", async () => {
    state.rpcError = { message: "boom" }
    expect(await syncPersonRootName("c1")).toEqual({ status: "failed", error: "boom" })
  })
})

describe("findRootMismatches", () => {
  it("lists only folders that differ from the contact's name", () => {
    const owners = [{ id: "o1", contact_id: "c1" }, { id: "o2", contact_id: "c2" }, { id: "o3", contact_id: "c3" }, { id: "o4", contact_id: "c4" }]
    const roots = new Map([["o1", "caterina"], ["o2", "Mario Rossi"], ["o3", "Client"], ["o4", "Old"]])
    const names = new Map<string, string | null>([["c1", "Caterina Levoni"], ["c2", "Mario Rossi"], ["c3", "Anna Bianchi"], ["c4", null]])
    const out = findRootMismatches(owners, roots, names)
    expect(out.map((m) => [m.ownerId, m.shouldBe])).toEqual([["o1", "Caterina Levoni"], ["o3", "Anna Bianchi"]])
  })
})
