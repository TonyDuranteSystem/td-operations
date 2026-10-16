import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  user: { id: "u1", app_metadata: { role: "admin" } } as unknown,
  catalogDefined: true,
  entries: [] as Array<Record<string, unknown>>,
  calls: [] as Array<[string, ...unknown[]]>,
}))

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/auth", () => ({ isAdmin: (u: { app_metadata?: { role?: string } } | null) => u?.app_metadata?.role === "admin" }))
vi.mock("@/lib/supabase-admin", () => {
  const chain = (table: string) => {
    const api: Record<string, unknown> = {}
    api.select = () => api
    api.eq = () => api
    api.not = () => api
    api.maybeSingle = () => Promise.resolve({ data: table === "catalog_definitions" && h.catalogDefined ? { id: "step_wait_kinds" } : null, error: null })
    api.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ waiting_on: "outside" }, { waiting_on: "outside" }], error: null }).then(res)
    return api
  }
  return { supabaseAdmin: { from: (t: string) => chain(t) } }
})
vi.mock("@/lib/catalog/framework", () => ({
  listEntries: async () => h.entries,
  getEntry: async (_c: string, slug: string) => h.entries.find(e => e.slug === slug) ?? null,
  addEntry: async (...a: unknown[]) => { h.calls.push(["add", ...a]); return {} },
  renameEntry: async (...a: unknown[]) => { h.calls.push(["rename", ...a]); return {} },
  deprecateEntry: async (...a: unknown[]) => { h.calls.push(["retire", ...a]); return {} },
  restoreEntry: async (...a: unknown[]) => { h.calls.push(["restore", ...a]); return {} },
}))

import { addWaitKind, loadWaitKindsAdmin, renameWaitKind, restoreWaitKind, retireWaitKind } from "@/app/(dashboard)/service-catalog/wait-kinds-actions"

beforeEach(() => {
  h.user = { id: "u1", app_metadata: { role: "admin" } }
  h.catalogDefined = true
  h.entries = [
    { id: "e1", slug: "outside", display_name: "An outside office", status: "active", metadata: { behaviour: "other" } },
    { id: "e2", slug: "old_bank", display_name: "Old bank", status: "deprecated", metadata: { behaviour: "other" } },
  ]
  h.calls.length = 0
})

describe("the waiting-on list actions are admin-only", () => {
  it("a non-admin is refused by every action and nothing is written", async () => {
    h.user = { id: "u2", app_metadata: { role: "team" } }
    expect(await addWaitKind({ name: "The IRS", behaviour: "other" })).toMatchObject({ ok: false, error: expect.stringContaining("Only an admin") })
    expect(await renameWaitKind({ slug: "outside", name: "X office" })).toMatchObject({ ok: false })
    expect(await retireWaitKind({ slug: "outside" })).toMatchObject({ ok: false })
    expect(await restoreWaitKind({ slug: "old_bank" })).toMatchObject({ ok: false })
    expect(await loadWaitKindsAdmin()).toHaveProperty("error")
    expect(h.calls).toEqual([])
  })

  it("no user at all is refused too", async () => {
    h.user = null
    expect(await addWaitKind({ name: "The IRS", behaviour: "other" })).toMatchObject({ ok: false })
    expect(h.calls).toEqual([])
  })
})

describe("before the migration (no catalog yet) the manager is inert and says so", () => {
  it("every action refuses in plain words, and the view reports 'not defined'", async () => {
    h.catalogDefined = false
    expect(await loadWaitKindsAdmin()).toEqual({ defined: false, rows: [] })
    for (const r of [
      await addWaitKind({ name: "The IRS", behaviour: "other" }),
      await renameWaitKind({ slug: "outside", name: "Another office" }),
      await retireWaitKind({ slug: "outside" }),
      await restoreWaitKind({ slug: "old_bank" }),
    ]) {
      expect(r).toMatchObject({ ok: false })
      expect((r as { error: string }).error).toMatch(/not set up yet/)
    }
    expect(h.calls).toEqual([])
  })
})

describe("addWaitKind", () => {
  it("adds a kind with a slug made from the name and the chosen behaviour in its metadata", async () => {
    expect(await addWaitKind({ name: "  The   IRS ", behaviour: "other" })).toEqual({ ok: true })
    const [kind, catalog, data] = h.calls[0] as [string, string, Record<string, unknown>]
    expect(kind).toBe("add")
    expect(catalog).toBe("step_wait_kinds")
    expect(data).toMatchObject({ slug: "the_irs", display_name: "The IRS", status: "active", metadata: { behaviour: "other" } })
  })

  it("only 'other' and 'date' can be chosen; a built-in behaviour cannot be created here", async () => {
    for (const b of ["ours", "client", "none", "", "banana"]) {
      expect(await addWaitKind({ name: "A kind", behaviour: b }), b).toMatchObject({ ok: false })
    }
    expect(h.calls).toEqual([])
  })

  it("refuses a bad or reserved name, a duplicate, and points a retired name to Restore", async () => {
    expect(await addWaitKind({ name: "x", behaviour: "other" })).toMatchObject({ ok: false })
    expect(await addWaitKind({ name: "Us", behaviour: "other" })).toMatchObject({ ok: false })
    expect(await addWaitKind({ name: "Unset", behaviour: "other" })).toMatchObject({ ok: false })
    expect(await addWaitKind({ name: "!!!", behaviour: "other" })).toMatchObject({ ok: false })
    expect(await addWaitKind({ name: "An Outside Office", behaviour: "other" })).toMatchObject({ ok: false, error: expect.stringContaining("already in the list") })
    expect(await addWaitKind({ name: "Old bank", behaviour: "other" })).toMatchObject({ ok: false, error: expect.stringContaining("Restore") })
    expect(h.calls).toEqual([])
  })
})

describe("rename, retire, restore", () => {
  it("rename changes only the name (never the slug) and does nothing when the name is the same", async () => {
    expect(await renameWaitKind({ slug: "outside", name: "Another office" })).toEqual({ ok: true })
    expect(h.calls[0].slice(0, 3)).toEqual(["rename", "e1", "Another office"])
    h.calls.length = 0
    expect(await renameWaitKind({ slug: "outside", name: "An outside office" })).toEqual({ ok: true })
    expect(h.calls).toEqual([])
    expect(await renameWaitKind({ slug: "outside", name: "x" })).toMatchObject({ ok: false })
  })

  it("the built-in kinds cannot be touched here, and an unknown kind is refused", async () => {
    for (const slug of ["us", "client", "none"]) expect(await retireWaitKind({ slug }), slug).toMatchObject({ ok: false })
    expect(await renameWaitKind({ slug: "us", name: "Ourselves" })).toMatchObject({ ok: false })
    expect(await retireWaitKind({ slug: "nope" })).toMatchObject({ ok: false })
    expect(h.calls).toEqual([])
  })

  it("retire and restore go through the catalog framework, and repeating them is harmless", async () => {
    expect(await retireWaitKind({ slug: "outside" })).toEqual({ ok: true })
    expect(h.calls[0].slice(0, 2)).toEqual(["retire", "e1"])
    expect(await restoreWaitKind({ slug: "old_bank" })).toEqual({ ok: true })
    expect(h.calls[1].slice(0, 2)).toEqual(["restore", "e2"])
    h.calls.length = 0
    expect(await retireWaitKind({ slug: "old_bank" })).toEqual({ ok: true })
    expect(await restoreWaitKind({ slug: "outside" })).toEqual({ ok: true })
    expect(h.calls).toEqual([])
  })
})

describe("loadWaitKindsAdmin", () => {
  it("lists the kinds (active first), their behaviour and how many steps use each", async () => {
    const v = await loadWaitKindsAdmin()
    expect(v).toEqual({
      defined: true,
      rows: [
        { slug: "outside", name: "An outside office", behaviour: "other", retired: false, usedBy: 2 },
        { slug: "old_bank", name: "Old bank", behaviour: "other", retired: true, usedBy: 0 },
      ],
    })
  })
})
