import { describe, it, expect, vi, beforeEach } from "vitest"

const state: { def: { data: unknown; error: { message: string } | null }; entries: { data: unknown; error: { message: string } | null } } = {
  def: { data: null, error: null },
  entries: { data: [], error: null },
}
const calls: string[] = []

vi.mock("@/lib/supabase-admin", () => {
  const chain = (table: string) => {
    const api: Record<string, unknown> = {}
    api.select = () => api
    api.eq = () => api
    api.in = () => api
    api.maybeSingle = () => Promise.resolve(state.def)
    api.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      calls.push(table)
      return Promise.resolve(state.entries).then(res, rej)
    }
    return api
  }
  return { supabaseAdmin: { from: (t: string) => chain(t) } }
})

import { loadWaitKinds } from "@/lib/services/wait-kinds-load"

/**
 * The kinds loader follows the rule these pages already keep: refuse instead of guessing.
 * No catalog yet → the two seeded kinds; a read error → throw; otherwise exactly what the catalog says.
 */
beforeEach(() => {
  state.def = { data: null, error: null }
  state.entries = { data: [], error: null }
  calls.length = 0
})

describe("loadWaitKinds", () => {
  it("catalog not set up yet (the migration has not run): the two seeded kinds, flagged as not defined, no list read", async () => {
    const r = await loadWaitKinds()
    expect(r.defined).toBe(false)
    expect(r.kinds.map(k => k.slug)).toEqual(["us", "client", "outside", "date", "none"])
    expect(calls).toEqual([])
  })

  it("catalog set up: built-ins + the catalog's kinds, retired ones included and flagged", async () => {
    state.def = { data: { id: "step_wait_kinds" }, error: null }
    state.entries = {
      data: [
        { slug: "outside", display_name: "An outside office", status: "active", metadata: { behaviour: "other" } },
        { slug: "the_irs", display_name: "The IRS", status: "active", metadata: { behaviour: "other" } },
        { slug: "old", display_name: "Old", status: "deprecated", metadata: { behaviour: "date" } },
      ],
      error: null,
    }
    const r = await loadWaitKinds()
    expect(r.defined).toBe(true)
    expect(r.kinds.map(k => [k.slug, k.retired])).toEqual([["us", false], ["client", false], ["outside", false], ["the_irs", false], ["old", true], ["none", false]])
    expect(r.problems).toEqual([])
  })

  it("an EMPTY catalog is not papered over: the built-ins only, so a step on a missing kind shows a warning instead of silently resolving", async () => {
    state.def = { data: { id: "step_wait_kinds" }, error: null }
    const r = await loadWaitKinds()
    expect(r.kinds.map(k => k.slug)).toEqual(["us", "client", "none"])
  })

  it("a bad row is skipped and reported, never hidden", async () => {
    state.def = { data: { id: "step_wait_kinds" }, error: null }
    state.entries = { data: [{ slug: "client", display_name: "Imposter", status: "active", metadata: {} }], error: null }
    const r = await loadWaitKinds()
    expect(r.kinds.map(k => k.slug)).toEqual(["us", "client", "none"])
    expect(r.kinds.find(k => k.slug === "client")!.name).toBe("The client")
    expect(r.problems).toHaveLength(1)
  })

  it("a read error THROWS (the page shows 'Could not load'), for the definition and for the list", async () => {
    state.def = { data: null, error: { message: "boom" } }
    await expect(loadWaitKinds()).rejects.toThrow(/could not read the list definition: boom/)
    state.def = { data: { id: "step_wait_kinds" }, error: null }
    state.entries = { data: null, error: { message: "nope" } }
    await expect(loadWaitKinds()).rejects.toThrow(/could not read the list: nope/)
  })
})
