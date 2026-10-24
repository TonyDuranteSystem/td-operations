import { describe, it, expect } from "vitest"
import { checkImportRange, importLeadsFromMeta, type ImportDeps } from "@/lib/marketing/meta-leads/import-history"
import type { IngestDeps } from "@/lib/marketing/meta-leads/ingest"
import type { GraphLead } from "@/lib/marketing/meta-leads/map-lead"
import { FakeDb } from "./helpers/fake-lead-db"

const NOW = new Date("2026-10-23T15:00:00Z")
const lead = (id: string, iso: string): GraphLead => ({
  id, created_time: iso, ad_id: "ad1", ad_name: "Ad", form_id: "f1",
  field_data: [{ name: "nome_e_cognome", values: [`Person ${id}`] }, { name: "e-mail", values: [`p${id}@x.com`] }, { name: "numero_di_telefono", values: ["+393331112233"] }],
} as GraphLead)

function setup(pages: GraphLead[][], held: string[] = []) {
  const db = new FakeDb()
  const calls: Array<string | null> = []
  const ingest = { db, fetchLead: async () => { throw new Error("must not refetch") }, resolveTeam: async () => "team1" } as unknown as IngestDeps
  const deps: ImportDeps = {
    ingest, pageIds: ["p1"],
    listForms: async () => [{ id: "f1" }],
    listLeadsPage: async (_f, after) => { calls.push(after); const i = after ? Number(after) : 0; return { leads: pages[i] ?? [], after: i + 1 < pages.length ? String(i + 1) : null } },
    alreadyHeld: async (ids) => new Set(ids.filter(i => held.includes(i))),
    dayOf: d => d.toISOString().slice(0, 10), now: () => NOW, budgetMs: 40_000,
  }
  return { db, deps, calls }
}
const range = { since: new Date("2026-10-17T00:00:00Z"), until: new Date("2026-10-19T00:00:00Z") }

describe("checkImportRange", () => {
  it("accepts a normal range", () => { expect(checkImportRange("2026-10-17T00:00:00Z", "2026-10-19T00:00:00Z", NOW).ok).toBe(true) })
  it("refuses bad, reversed, future, too old and too long ranges", () => {
    for (const [s, u] of [["x", "y"], [null, undefined], ["2026-10-19T00:00:00Z", "2026-10-17T00:00:00Z"], ["2026-10-20T00:00:00Z", "2026-11-30T00:00:00Z"], ["2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z"], ["2026-09-01T00:00:00Z", "2026-10-22T00:00:00Z"]]) {
      expect(checkImportRange(s, u, NOW).ok, `${s} ${u}`).toBe(false)
    }
  })
})

describe("importLeadsFromMeta", () => {
  const pages = [[lead("5", "2026-10-20T10:00:00Z"), lead("4", "2026-10-18T22:00:00Z")], [lead("3", "2026-10-18T09:00:00Z"), lead("2", "2026-10-17T12:00:00Z")], [lead("1", "2026-10-16T12:00:00Z")]]
  it("dry run: counts per day, writes nothing, stops at the page that reaches back before the start", async () => {
    const { db, deps, calls } = setup(pages)
    const r = await importLeadsFromMeta(deps, range, true)
    expect(r).toMatchObject({ dryRun: true, seen: 3, alreadyHeld: 0, added: 3, stoppedEarly: false })
    expect(r.days).toEqual([{ day: "2026-10-17", seen: 1, alreadyHeld: 0, added: 1 }, { day: "2026-10-18", seen: 2, alreadyHeld: 0, added: 2 }])
    expect(db.rows("marketing_leads")).toHaveLength(0)
    expect(calls).toEqual([null, "1", "2"]) // stops at the page that reaches back before the start (page 3), reads no further
  })
  it("real run: stores each in-range lead once, at the day it arrived, with its event", async () => {
    const { db, deps } = setup(pages)
    const r = await importLeadsFromMeta(deps, range, false)
    expect(r.added).toBe(3)
    const rows = db.rows("marketing_leads")
    expect(rows.map(x => x.leadgen_id).sort()).toEqual(["2", "3", "4"])
    expect(rows.find(x => x.leadgen_id === "2")?.received_at).toBe("2026-10-17T12:00:00.000Z")
    expect(db.rows("marketing_lead_events").filter(e => e.kind === "received")).toHaveLength(3)
  })
  it("running it again adds nothing", async () => {
    const { db, deps } = setup(pages)
    await importLeadsFromMeta(deps, range, false)
    const held = db.rows("marketing_leads").map(x => String(x.leadgen_id))
    const again = setup(pages, held)
    again.db.tables = db.tables
    const r = await importLeadsFromMeta(again.deps, range, false)
    expect(r).toMatchObject({ seen: 3, alreadyHeld: 3, added: 0 })
    expect(db.rows("marketing_leads")).toHaveLength(3)
  })
  it("a lead we already hold is counted, not added (dry run too)", async () => {
    const { deps } = setup(pages, ["3"])
    const r = await importLeadsFromMeta(deps, range, true)
    expect(r).toMatchObject({ seen: 3, alreadyHeld: 1, added: 2 })
  })
  it("a Meta error on one form is reported, not thrown", async () => {
    const { deps } = setup(pages)
    deps.listLeadsPage = async () => { throw new Error("Graph 190: token expired") }
    const r = await importLeadsFromMeta(deps, range, false)
    expect(r.added).toBe(0)
    expect(r.errors[0]).toMatch(/token expired/)
  })
  it("stops early (and says so) when the time budget is used up", async () => {
    const { deps } = setup(pages)
    let t = 0
    deps.now = () => new Date(NOW.getTime() + (t += 30_000))
    const r = await importLeadsFromMeta(deps, range, true)
    expect(r.stoppedEarly).toBe(true)
  })
  it("a lead with no readable date is ignored, never stored", async () => {
    const { db, deps } = setup([[{ ...lead("9", "2026-10-18T10:00:00Z"), created_time: undefined } as GraphLead]])
    const r = await importLeadsFromMeta(deps, range, false)
    expect(r.seen).toBe(0)
    expect(db.rows("marketing_leads")).toHaveLength(0)
  })
})
