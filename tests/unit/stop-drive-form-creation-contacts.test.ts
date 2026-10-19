import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Stop-Drive S1a round 5: the STAFF form-creation tools (formation / onboarding / ITIN / closure) used to attach the contact whose email
 * equals the lead's — name never checked. A couple sharing one address got the other person's contact (and prefilled data) on the form.
 * They now use the one shared rule (exact email AND the same full name), and the form token no longer collapses for non-Latin names.
 */
const state: { lead: Record<string, unknown>; contacts: Array<Record<string, unknown>>; inserts: Array<[string, Record<string, unknown>]> } = { lead: {}, contacts: [], inserts: [] }
const alarms: string[] = []

vi.mock("@/lib/supabase-admin", () => {
  const make = (table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ["select", "eq", "is", "ilike", "in", "gte", "update", "not"]) chain[m] = () => chain
    chain.contains = () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) })
    chain.order = () => chain
    chain.range = async (from: number) => ({ data: table === "contacts" && from === 0 ? state.contacts : [], error: null })
    chain.limit = async () => ({ data: [], error: null })
    chain.insert = (payload: Record<string, unknown>) => { state.inserts.push([table, payload]); return chain }
    chain.single = async () => (table === "leads" ? { data: state.lead, error: null } : { data: { id: "sub-1", token: "tok", access_code: "123456" }, error: null })
    chain.maybeSingle = async () => ({ data: null, error: null })
    return chain
  }
  return { supabaseAdmin: { from: make } }
})
vi.mock("@/lib/crm-store/formation-pilot", () => ({ raisePilotAlarm: vi.fn(async (k: string) => { alarms.push(k) }) }))
vi.mock("@/lib/formation/state-lookup", () => ({ formationStateForClient: async () => null }))

import { registerFormationTools } from "@/lib/mcp/tools/formation"
import { registerOnboardingTools } from "@/lib/mcp/tools/onboarding"
import { registerITINFormTools } from "@/lib/mcp/tools/itin-form"
import { registerClosureTools } from "@/lib/mcp/tools/closure"

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
function toolsOf(register: (s: never) => void): Record<string, Handler> {
  const tools: Record<string, Handler> = {}
  register({ tool: (name: string, ...rest: unknown[]) => { tools[name] = rest[rest.length - 1] as Handler } } as never)
  return tools
}

const LEAD_ID = "11111111-1111-4111-8111-111111111111"
const CREATE: Array<{ name: string; table: string; register: (s: never) => void; args: Record<string, unknown> }> = [
  { name: "formation_form_create", table: "formation_submissions", register: registerFormationTools as never, args: { lead_id: LEAD_ID } },
  { name: "onboarding_form_create", table: "onboarding_submissions", register: registerOnboardingTools as never, args: { lead_id: LEAD_ID } },
  { name: "itin_form_create", table: "itin_submissions", register: registerITINFormTools as never, args: { lead_id: LEAD_ID } },
  { name: "closure_form_create", table: "closure_submissions", register: registerClosureTools as never, args: { lead_id: LEAD_ID } },
]

beforeEach(() => { state.inserts = []; alarms.length = 0 })

const setLeadAndContact = (leadName: string, contactName: string) => {
  state.lead = { id: LEAD_ID, full_name: leadName, email: "famiglia@x.it", phone: null, language: "en", status: "Qualified" }
  state.contacts = [{ id: "anna-contact", email: "famiglia@x.it", full_name: contactName }]
}

for (const t of CREATE) {
  describe(`${t.name} — contact chosen by the shared rule`, () => {
    it("Marco Zqrossi (lead) vs Anna Zqrossi (contact) on one email: NO contact attached, one alarm", async () => {
      setLeadAndContact("Marco Zqrossi", "Anna Zqrossi")
      const out = await toolsOf(t.register)[t.name](t.args)
      expect(out.content[0].text).not.toMatch(/^Error/)
      const row = state.inserts.find(([tbl]) => tbl === t.table)![1]
      expect(row.contact_id ?? null).toBeNull()
      expect(alarms).toEqual(["lead_form_contact_ambiguous"])
    })
    it("李小龙 (lead) vs 王小明 (contact): NO contact attached, one alarm, and the token is not '-2026'", async () => {
      setLeadAndContact("李小龙", "王小明")
      await toolsOf(t.register)[t.name](t.args)
      const row = state.inserts.find(([tbl]) => tbl === t.table)![1]
      expect(row.contact_id ?? null).toBeNull()
      expect(alarms).toEqual(["lead_form_contact_ambiguous"])
      const year = new Date().getFullYear()
      expect(String(row.token)).toMatch(new RegExp(`u[0-9a-f]{12}-${year}$`))
      expect(String(row.token)).not.toMatch(new RegExp(`(^|-)-${year}$`))
    })
    it("the same person (names swapped) IS attached, no alarm", async () => {
      setLeadAndContact("Mario Rossi", "Rossi Mario")
      await toolsOf(t.register)[t.name](t.args)
      const row = state.inserts.find(([tbl]) => tbl === t.table)![1]
      // closure/itin/onboarding carry the contact only where the table has the column; formation stores contact_id
      if (t.table === "formation_submissions") expect(row.contact_id).toBe("anna-contact")
      expect(alarms).toEqual([])
    })
  })
}
