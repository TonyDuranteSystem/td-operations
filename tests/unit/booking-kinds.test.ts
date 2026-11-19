import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { parseKindRule, buildRuleSnapshot, parseRuleSnapshot, kindNameKey, kindNameTaken, type KindRule } from "@/lib/booking/kinds"

const rule: KindRule = { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false }

describe("parseKindRule", () => {
  it("reads a complete rule", () => {
    const r = parseKindRule({ ...rule, sort_order: 30 })
    expect(r).toEqual({ ok: true, rule, sortOrder: 30 })
  })
  it("a kind added through a generic tool (no metadata) is 'needs setup'", () => {
    for (const bad of [null, undefined, {}, [], "x", 5]) {
      const r = parseKindRule(bad)
      expect(r.ok).toBe(false)
    }
  })
  it("refuses an unknown answer or a missing switch", () => {
    expect(parseKindRule({ ...rule, existing_person: "email_them" }).ok).toBe(false)
    expect(parseKindRule({ ...rule, new_person: "attach" }).ok).toBe(false)
    expect(parseKindRule({ ...rule, mark_lead: "yes" }).ok).toBe(false)
    expect(parseKindRule({ ...rule, sales_template: undefined }).ok).toBe(false)
  })
  it("a missing sort order sorts last, it does not fail", () => {
    const r = parseKindRule(rule)
    expect(r.ok && r.sortOrder).toBe(1000)
  })
})

describe("rule snapshot", () => {
  it("round-trips and is a copy (editing the kind later cannot change it)", () => {
    const snap = buildRuleSnapshot({ slug: "partner", label: "Partner" }, rule)
    rule.mark_lead = true
    expect(parseRuleSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap)
    const other = { ...rule }
    const snap2 = buildRuleSnapshot({ slug: "x", label: "X" }, other)
    other.mark_lead = false
    expect(snap2.rule.mark_lead).toBe(true)
  })
  it("a malformed or wrong-version snapshot is null (the webhook then keeps today's behaviour)", () => {
    expect(parseRuleSnapshot(null)).toBeNull()
    expect(parseRuleSnapshot({})).toBeNull()
    expect(parseRuleSnapshot({ v: 2, kind_slug: "a", kind_label: "A", rule })).toBeNull()
    expect(parseRuleSnapshot({ v: 1, kind_slug: "a", kind_label: "A", rule: { existing_person: "attach" } })).toBeNull()
    expect(parseRuleSnapshot({ v: 1, kind_slug: 3, kind_label: "A", rule })).toBeNull()
  })
})

describe("kind names", () => {
  it("compare ignoring capitals, accents and extra spaces", () => {
    expect(kindNameKey("  Clïent  ")).toBe("client")
    expect(kindNameTaken("CLIENT", ["Lead", "Client"])).toBe(true)
    expect(kindNameTaken("Cliënt", ["Lead", "Client"])).toBe(true)
    expect(kindNameTaken("Part  ner", ["Partner"])).toBe(false)
    expect(kindNameTaken("Supplier", ["Lead", "Client"])).toBe(false)
  })
  it("an empty name is always 'taken' (refused)", () => {
    expect(kindNameTaken("   ", [])).toBe(true)
  })
})

describe("the four seeded kinds in migration M1", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "scripts", "migrations", "20261113-1710-booking-kinds-catalog.sql"), "utf8")
  const seeds = Array.from(sql.matchAll(/\('booking_kinds',\s*'([a-z_]+)',\s*'([^']+)',[^\n]*?'(\{"existing_person[^']*\})'::jsonb\)/g))
  it("has exactly Lead, Client, Partner, Private", () => {
    expect(seeds.map((m) => m[1])).toEqual(["lead", "client", "partner", "private"])
  })
  it("every seed rule parses with the same code that the maker and the webhook use", () => {
    for (const m of seeds) expect(parseKindRule(JSON.parse(m[3])).ok).toBe(true)
  })
  it("pins the behaviour the plan promises", () => {
    const by = Object.fromEntries(seeds.map((m) => [m[1], JSON.parse(m[3])]))
    expect(by.lead).toMatchObject({ existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true })
    expect(by.client).toMatchObject({ existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false })
    expect(by.partner).toMatchObject({ existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false })
    expect(by.private).toMatchObject({ existing_person: "none", new_person: "none", mark_lead: false, sales_template: false })
  })
  it("seeds never overwrite a rename or a changed rule on a re-run", () => {
    expect(sql).toMatch(/ON CONFLICT \(catalog_id, slug\) DO NOTHING/)
  })
})
