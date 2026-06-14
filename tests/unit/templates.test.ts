/**
 * CRM approved-message templates loader — lib/ai-agent/templates.ts
 *
 * Two halves:
 *   1. Pure helpers (extractKeywords, formatTemplatesForPrompt) — no DB.
 *   2. loadRelevantTemplates / searchTemplates against an in-memory supabase
 *      mock that honours `.eq` + `.ilike` filters (so active-only exclusion and
 *      category filtering are actually exercised). The `.or()` keyword prefilter
 *      is a superset in the mock — JS scoring does the real ranking.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── in-memory two-table store the mock reads from ───────────────────────────
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}))

vi.mock("@/lib/supabase-admin", () => {
  function makeBuilder(table: string) {
    const eqFilters: Array<[string, unknown]> = []
    const ilikeFilters: Array<[string, string]> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select() { return builder },
      limit() { return builder },
      eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
      ilike(col: string, pat: string) { ilikeFilters.push([col, pat]); return builder },
      or() { return builder }, // keyword prefilter — superset in the mock
      // thenable so `await builder` resolves to { data, error }
      then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
        let rows = (h.tables[table] ?? []).slice()
        for (const [c, v] of eqFilters) rows = rows.filter((r) => r[c] === v)
        for (const [c, pat] of ilikeFilters) {
          const needle = pat.replace(/%/g, "").toLowerCase()
          rows = rows.filter((r) => String(r[c] ?? "").toLowerCase().includes(needle))
        }
        return resolve({ data: rows, error: null })
      },
    }
    return builder
  }
  return { supabaseAdmin: { from: (t: string) => makeBuilder(t) } }
})

import {
  extractKeywords,
  formatTemplatesForPrompt,
  loadRelevantTemplates,
  searchTemplates,
  type RelevantTemplate,
} from "@/lib/ai-agent/templates"

beforeEach(() => {
  h.tables = { templates: [], email_templates: [] }
})

// ── extractKeywords (pure) ──────────────────────────────────────────────────
describe("extractKeywords", () => {
  it("lowercases, strips punctuation, drops stopwords and pure numbers", () => {
    const kw = extractKeywords("Hello, I NEED help with my BANKING account!! 2026")
    expect(kw).toContain("banking")
    expect(kw).toContain("account")
    expect(kw).toContain("help")
    expect(kw).not.toContain("need") // stopword
    expect(kw).not.toContain("hello") // stopword
    expect(kw).not.toContain("2026") // pure numeric
  })

  it("keeps critical 3-letter domain terms (tax, ein, llc)", () => {
    expect(extractKeywords("I need my tax return")).toContain("tax")
    expect(extractKeywords("where is the EIN")).toContain("ein")
    expect(extractKeywords("close my llc please")).toContain("llc")
  })

  it("dedupes and caps the list", () => {
    expect(extractKeywords("tax tax tax tax")).toEqual(["tax"])
    const many = extractKeywords(
      "banking formation passport invoice payment renewal closure shipping notary deadline contract address extra",
      5,
    )
    expect(many).toHaveLength(5)
  })

  it("never leaks PostgREST-breaking characters into a keyword", () => {
    for (const w of extractKeywords("a@b.com, (x) y; z%pattern")) {
      expect(w).toMatch(/^[a-z0-9]+$/)
    }
  })

  it("returns [] for empty/whitespace input", () => {
    expect(extractKeywords("")).toEqual([])
    expect(extractKeywords("   ")).toEqual([])
  })
})

// ── formatTemplatesForPrompt (pure) ─────────────────────────────────────────
describe("formatTemplatesForPrompt", () => {
  it("returns '' for an empty list (no-op injection)", () => {
    expect(formatTemplatesForPrompt([])).toBe("")
  })

  it("includes the APPROVED TEMPLATES header and each template name + body", () => {
    const tmpls: RelevantTemplate[] = [
      { source: "message", template_name: "Banking Intro", category: "banking", language: "English", trigger: "bank", text: "Hi {name}, here is how to open your account.", score: 2 },
    ]
    const out = formatTemplatesForPrompt(tmpls)
    expect(out).toContain("APPROVED TEMPLATES")
    expect(out).toContain("Banking Intro")
    expect(out).toContain("here is how to open your account")
  })
})

// ── loadRelevantTemplates (mocked DB) ───────────────────────────────────────
describe("loadRelevantTemplates", () => {
  it("ranks the keyword-matching template above non-matching ones and caps at limit", async () => {
    h.tables.templates = [
      { template_name: "Banking Setup", trigger_keyword: "banking account", category: "banking", language: "English", template_text: "Open your bank account here." },
      { template_name: "Tax Return Info", trigger_keyword: "tax return", category: "tax", language: "English", template_text: "Your tax return is due." },
      { template_name: "Shipping Note", trigger_keyword: "shipping", category: "shipping", language: "English", template_text: "Your package shipped." },
    ]
    const out = await loadRelevantTemplates("how do I open my banking account", { limit: 3 })
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].template_name).toBe("Banking Setup")
    // Non-matching templates (no keyword overlap) are dropped (score 0).
    expect(out.find((t) => t.template_name === "Shipping Note")).toBeUndefined()
  })

  it("soft-boosts a same-language template on a score tie", async () => {
    h.tables.templates = [
      { template_name: "Banking EN", trigger_keyword: "banking", category: "banking", language: "English", template_text: "EN copy" },
      { template_name: "Banking IT", trigger_keyword: "banking", category: "banking", language: "Italian", template_text: "IT copy" },
    ]
    const out = await loadRelevantTemplates("banking", { language: "Italian", limit: 1 })
    expect(out[0].template_name).toBe("Banking IT")
  })

  it("returns [] when no keyword matches (no prompt injection)", async () => {
    h.tables.templates = [
      { template_name: "Banking Setup", trigger_keyword: "banking", category: "banking", language: "English", template_text: "x" },
    ]
    const out = await loadRelevantTemplates("completely unrelated zzzxxx")
    expect(out).toEqual([])
  })

  it("excludes inactive email_templates", async () => {
    h.tables.email_templates = [
      { template_name: "Welcome Active", subject_template: "Welcome", body_template: "banking welcome", trigger_event: "banking", category: "banking", language: "English", active: true },
      { template_name: "Welcome Inactive", subject_template: "Old", body_template: "banking old", trigger_event: "banking", category: "banking", language: "English", active: false },
    ]
    const out = await loadRelevantTemplates("banking", { limit: 5 })
    expect(out.find((t) => t.template_name === "Welcome Active")).toBeDefined()
    expect(out.find((t) => t.template_name === "Welcome Inactive")).toBeUndefined()
  })

  it("combines subject + body for email templates", async () => {
    h.tables.email_templates = [
      { template_name: "Banking Email", subject_template: "Your bank account", body_template: "Details inside about banking.", trigger_event: "banking", category: "banking", language: "English", active: true },
    ]
    const out = await loadRelevantTemplates("banking", { limit: 5 })
    const email = out.find((t) => t.source === "email")
    expect(email).toBeDefined()
    expect(email!.text).toContain("Subject: Your bank account")
    expect(email!.text).toContain("Details inside about banking")
  })
})

// ── searchTemplates (worker tool path) ──────────────────────────────────────
describe("searchTemplates", () => {
  it("filters by category when no query keywords are present", async () => {
    h.tables.templates = [
      { template_name: "Banking A", trigger_keyword: "x1", category: "banking", language: "English", template_text: "a" },
      { template_name: "Tax B", trigger_keyword: "x2", category: "tax", language: "English", template_text: "b" },
    ]
    const out = await searchTemplates({ query: "", category: "banking" })
    expect(out).toHaveLength(1)
    expect(out[0].template_name).toBe("Banking A")
  })

  it("returns [] when neither query keywords nor category are given", async () => {
    h.tables.templates = [
      { template_name: "Banking A", trigger_keyword: "banking", category: "banking", language: "English", template_text: "a" },
    ]
    const out = await searchTemplates({ query: "" })
    expect(out).toEqual([])
  })
})
