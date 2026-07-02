/**
 * Unit tests for lib/operations/ss4-refresh.ts — the shared SS-4 in-place
 * refresh behind the CRM regenerate, the flow-workspace regenerate, and the
 * member-change auto-refresh (AI Venture Labs incident, 2026-07-02).
 *
 * computeSs4RefreshUpdates is pure — most coverage lives there. refreshSS4 is
 * exercised with the table-keyed supabase mock (same pattern as
 * action-required.test.ts) for the outcomes that involve DB state: no_ss4,
 * locked, needs_signer (row untouched), refreshed (+ signer-change notify only
 * on awaiting_signature).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
// vi.mock calls are hoisted above imports, so the mocked supabase/action-log
// modules are in place before ss4-refresh loads.
import {
  refreshSS4,
  computeSs4RefreshUpdates,
  resolveEntityType,
  resolveStateCode,
  resolveMailing,
  type Ss4RowSnapshot,
  type Ss4AccountSnapshot,
} from "@/lib/operations/ss4-refresh"

// ── Fixtures shared with the mocked supabase client ──────────────────────────
interface MemberRow {
  id: string
  member_type: string
  full_name: string | null
  company_name: string | null
  contact_id: string | null
  representative_name: string | null
  representative_email: string | null
  is_primary: boolean
  is_signer: boolean
}

const fixtures: {
  ss4: Record<string, unknown> | null
  account: Record<string, unknown> | null
  members: MemberRow[]
  contact: Record<string, unknown> | null
  raAddress: Record<string, unknown> | null
  updateResult: { data: Array<{ id: string }> | null; error: { message: string } | null }
} = {
  ss4: null,
  account: null,
  members: [],
  contact: null,
  raAddress: null,
  updateResult: { data: [{ id: "ss4-1" }], error: null },
}

const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = []
const logCalls: Array<Record<string, unknown>> = []
const notifyCalls: Array<Record<string, unknown>> = []

function resolveFor(table: string, op: string) {
  if (op === "update") return { data: fixtures.updateResult.data, error: fixtures.updateResult.error }
  if (table === "ss4_applications") return { data: fixtures.ss4, error: null }
  if (table === "accounts") return { data: fixtures.account, error: null }
  if (table === "members") return { data: fixtures.members, error: null }
  if (table === "contacts") return { data: fixtures.contact, error: null }
  if (table === "addresses") return { data: fixtures.raAddress, error: null }
  return { data: null, error: null }
}

function makeBuilder(table: string) {
  const state = { table, op: "select", values: {} as Record<string, unknown> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.in = chain
  b.is = chain
  b.order = chain
  b.update = (values: Record<string, unknown>) => {
    state.op = "update"
    state.values = values
    updateCalls.push({ table, values })
    return b
  }
  b.maybeSingle = () => Promise.resolve(resolveFor(state.table, state.op))
  b.single = () => Promise.resolve(resolveFor(state.table, state.op))
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveFor(state.table, state.op)).then(resolve, reject)
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}))
vi.mock("@/lib/mcp/action-log", () => ({
  logAction: (args: Record<string, unknown>) => {
    logCalls.push(args)
    return Promise.resolve()
  },
}))
vi.mock("@/lib/portal/action-required", () => ({
  notifySs4ReadyToSign: (args: Record<string, unknown>) => {
    notifyCalls.push(args)
    return Promise.resolve({ chat: true, email: true, notification: true })
  },
}))

// ── Pure fixtures ─────────────────────────────────────────────────────────────
const baseRow: Ss4RowSnapshot = {
  id: "ss4-1",
  token: "ss4-acme-llc-2026",
  access_code: "abcd1234",
  status: "draft",
  signed_at: null,
  contact_id: "c-gaia",
  company_name: "Acme LLC",
  entity_type: "MMLLC",
  state_of_formation: "NM",
  formation_date: "2026-06-16",
  member_count: 4,
  responsible_party_name: "Gaia Pellegrinelli",
  responsible_party_itin: null,
  responsible_party_phone: "+390000000",
  responsible_party_title: "Member",
  language: "en",
  county_and_state: "Bernalillo County, New Mexico",
  mailing_street: "11125 Park Blvd, Suite 104-153",
  mailing_city_state_zip: "Seminole, FL 33772",
}

const baseAccount: Ss4AccountSnapshot = {
  company_name: "Acme LLC",
  entity_type: "Multi Member LLC",
  state_of_formation: "New Mexico",
  formation_date: "2026-06-16",
  physical_address: null,
  mailing_address: null,
}

const michele = {
  id: "c-michele",
  full_name: "Michele Cotti",
  itin_number: "900-59-3806",
  phone: "+17273032244",
  language: "Italian",
}

describe("resolveEntityType / resolveStateCode", () => {
  it("maps account entity strings to SS-4 entity types", () => {
    expect(resolveEntityType("Multi Member LLC")).toBe("MMLLC")
    expect(resolveEntityType("multi-member llc")).toBe("MMLLC")
    expect(resolveEntityType("Single Member LLC")).toBe("SMLLC")
    expect(resolveEntityType("Corporation")).toBe("Corporation")
    expect(resolveEntityType(null)).toBe("SMLLC")
  })

  it("maps state names to codes, passes unknown through", () => {
    expect(resolveStateCode("New Mexico")).toBe("NM")
    expect(resolveStateCode("wyoming")).toBe("WY")
    expect(resolveStateCode("Texas")).toBe("Texas")
  })
})

describe("resolveMailing", () => {
  it("prefers the joined mailing address", () => {
    const m = resolveMailing({
      ...baseAccount,
      mailing_address: { address_line1: "1 Main St", address_line2: "Ste 2", city: "Largo", state: "FL", zip: "33771" },
    })
    expect(m).toEqual({ street: "1 Main St, Ste 2", cityStateZip: "Largo, FL, 33771" })
  })

  it("falls back to physical_address split at the first comma", () => {
    const m = resolveMailing({ ...baseAccount, physical_address: "9 Elm Rd, Casper, WY 82609" })
    expect(m).toEqual({ street: "9 Elm Rd", cityStateZip: "Casper, WY 82609" })
  })

  it("falls back to the TD mailing address when nothing is set", () => {
    const m = resolveMailing(baseAccount)
    expect(m.street).toContain("11125 Park Blvd")
  })
})

describe("computeSs4RefreshUpdates", () => {
  it("returns unchanged when the row already matches current data", () => {
    const c = computeSs4RefreshUpdates({
      ss4: baseRow,
      account: baseAccount,
      memberCount: 4,
      signerContact: {
        id: "c-gaia",
        full_name: "Gaia Pellegrinelli",
        itin_number: null,
        phone: "+390000000",
        language: "English",
      },
      raCountyAndState: "Bernalillo County, New Mexico",
    })
    expect(c.kind).toBe("unchanged")
  })

  it("detects a signer change and rewrites all responsible-party fields (the Michele fix)", () => {
    const c = computeSs4RefreshUpdates({
      ss4: baseRow,
      account: baseAccount,
      memberCount: 4,
      signerContact: michele,
      raCountyAndState: "Bernalillo County, New Mexico",
    })
    expect(c.kind).toBe("update")
    if (c.kind !== "update") return
    expect(c.signerChanged).toBe(true)
    expect(c.updates.contact_id).toBe("c-michele")
    expect(c.updates.responsible_party_name).toBe("Michele Cotti")
    expect(c.updates.responsible_party_itin).toBe("900-59-3806")
    expect(c.updates.language).toBe("it") // Italian signer → it (fixes the language gap)
  })

  it("keeps the signer fields untouched when signerContact is null (no members rows — never guess)", () => {
    const c = computeSs4RefreshUpdates({
      ss4: { ...baseRow, company_name: "Acme Renamed LLC" }, // stale name forces an update
      account: baseAccount,
      memberCount: 4,
      signerContact: null,
      raCountyAndState: "Bernalillo County, New Mexico",
    })
    expect(c.kind).toBe("update")
    if (c.kind !== "update") return
    expect(c.signerChanged).toBe(false)
    expect(c.updates).not.toHaveProperty("contact_id")
    expect(c.updates).not.toHaveProperty("responsible_party_name")
    expect(c.updates.company_name).toBe("Acme LLC")
  })

  it("never degrades Line 6: missing RA county keeps the stored county", () => {
    const c = computeSs4RefreshUpdates({
      ss4: { ...baseRow, member_count: 3 }, // stale count forces an update
      account: baseAccount,
      memberCount: 4,
      signerContact: null,
      raCountyAndState: null,
    })
    expect(c.kind).toBe("update")
    if (c.kind !== "update") return
    expect(c.updates).not.toHaveProperty("county_and_state")
    expect(c.updates.member_count).toBe(4)
  })

  it("sets the title by entity type", () => {
    const c = computeSs4RefreshUpdates({
      ss4: { ...baseRow, entity_type: "SMLLC", responsible_party_title: "Member", member_count: 1 },
      account: { ...baseAccount, entity_type: "Single Member LLC" },
      memberCount: 1,
      signerContact: { ...michele, language: "English" },
      raCountyAndState: "Bernalillo County, New Mexico",
    })
    expect(c.kind).toBe("update")
    if (c.kind !== "update") return
    expect(c.updates.responsible_party_title).toBe("Owner")
  })
})

// ── refreshSS4 wrapper (mocked DB) ───────────────────────────────────────────

const dbSs4Row = {
  ...baseRow,
} as Record<string, unknown>

const dbAccount = {
  id: "acc-1",
  company_name: "Acme LLC",
  entity_type: "Multi Member LLC",
  state_of_formation: "New Mexico",
  formation_date: "2026-06-16",
  physical_address: null,
  registered_agent_id: "ra-1",
  mailing_address: null,
}

const memberMichele: MemberRow = {
  id: "m-1", member_type: "individual", full_name: "Michele Cotti", company_name: null,
  contact_id: "c-michele", representative_name: null, representative_email: null,
  is_primary: true, is_signer: true,
}
const memberGaia: MemberRow = {
  id: "m-2", member_type: "individual", full_name: "Gaia Pellegrinelli", company_name: null,
  contact_id: "c-gaia", representative_name: null, representative_email: null,
  is_primary: false, is_signer: false,
}

beforeEach(() => {
  fixtures.ss4 = { ...dbSs4Row }
  fixtures.account = { ...dbAccount }
  fixtures.members = [memberMichele, memberGaia]
  fixtures.contact = { ...michele }
  fixtures.raAddress = { county: "Bernalillo", state: "NM" }
  fixtures.updateResult = { data: [{ id: "ss4-1" }], error: null }
  updateCalls.length = 0
  logCalls.length = 0
  notifyCalls.length = 0
})

describe("refreshSS4", () => {
  it("no_ss4 when the account has no SS-4", async () => {
    fixtures.ss4 = null
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r).toEqual({ ok: true, outcome: "no_ss4" })
    expect(updateCalls).toHaveLength(0)
  })

  it("locked for a signed SS-4 — never rewritten", async () => {
    fixtures.ss4 = { ...dbSs4Row, status: "signed", signed_at: "2026-07-01T00:00:00Z" }
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r.outcome).toBe("locked")
    expect(updateCalls).toHaveLength(0)
  })

  it("needs_signer (MMLLC, zero flagged) — row untouched, staff alert returned and logged", async () => {
    fixtures.members = [{ ...memberMichele, is_signer: false }, memberGaia]
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r.outcome).toBe("needs_signer")
    expect(r.message).toContain("no signer")
    expect(updateCalls).toHaveLength(0)
    expect(logCalls.some((l) => String(l.summary).includes("SKIPPED"))).toBe(true)
  })

  it("refreshed: draft signer change updates the row but does NOT notify", async () => {
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r.outcome).toBe("refreshed")
    expect(r.signerChanged).toBe(true)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].values.contact_id).toBe("c-michele")
    expect(notifyCalls).toHaveLength(0) // drafts stay silent
    expect(r.ss4?.responsible_party_name).toBe("Michele Cotti")
  })

  it("refreshed: signer change while awaiting_signature notifies the NEW signer", async () => {
    fixtures.ss4 = { ...dbSs4Row, status: "awaiting_signature" }
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r.outcome).toBe("refreshed")
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]).toEqual({ ss4Id: "ss4-1" })
  })

  it("unchanged: no write and no notification when data already matches", async () => {
    fixtures.ss4 = {
      ...dbSs4Row,
      contact_id: "c-michele",
      responsible_party_name: "Michele Cotti",
      responsible_party_itin: "900-59-3806",
      responsible_party_phone: "+17273032244",
      language: "it",
      member_count: 2,
    }
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r.outcome).toBe("unchanged")
    expect(updateCalls).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })

  it("locked (TOCTOU): the client signed between read and write — no notify, clear message", async () => {
    fixtures.updateResult = { data: [], error: null }
    const r = await refreshSS4({ account_id: "acc-1", source: "test" })
    expect(r.outcome).toBe("locked")
    expect(r.message).toContain("signed while the refresh was running")
    expect(notifyCalls).toHaveLength(0)
  })
})
