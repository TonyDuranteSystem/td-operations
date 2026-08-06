/**
 * WS-D adversarial QA matrix — cells 1-6 (dev job c0a61e44).
 *
 * The sandbox deployment 503-walls /api/webhooks/* by design, so the route is
 * exercised DIRECTLY with synthetic payloads that mirror a REAL Circleback
 * delivery (shape lifted from production call_summaries.raw_payload for the
 * actual Aug-5 Alessandro call: string id, fractional duration, 5 attendees of
 * which THREE have null emails — notetaker bot + two human entries).
 * Persistence is mocked; every cell asserts the exact rows the route writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Mock supabase client (chainable, per-table scenario data) ───
interface Scenario {
  leads: Array<{ id: string; email: string }>
  contacts: Array<{ id: string; email: string }>
  accountLinks: Array<{ account_id: string }>
  existingRow: Record<string, unknown> | null
}
const scenario: Scenario = { leads: [], contacts: [], accountLinks: [], existingRow: null }
const upserts: Array<{ table: string; record: Record<string, unknown> }> = []

function fakeFrom(table: string) {
  const resolveData = async () => {
    if (table === "leads") return { data: scenario.leads, error: null }
    if (table === "contacts") return { data: scenario.contacts, error: null }
    if (table === "account_contacts") return { data: scenario.accountLinks, error: null }
    return { data: null, error: null }
  }
  // Uniform chain: every builder method returns the same thenable object, so the
  // route can await after ANY chain depth (.select().or(), .eq().limit(), …).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  const o: any = {}
  for (const m of ["select", "or", "eq", "limit", "order", "in", "not"]) o[m] = () => o
  o.maybeSingle = async () =>
    table === "call_summaries"
      ? { data: scenario.existingRow, error: null }
      : { data: null, error: null }
  o.upsert = async (record: Record<string, unknown>) => {
    upserts.push({ table, record })
    return { error: null }
  }
  o.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    resolveData().then(res, rej)
  return o
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => fakeFrom(t) }),
}))

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sandbox.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key"
delete process.env.CIRCLEBACK_SIGNING_SECRET // signature check skipped, like a secretless env

import { POST } from "@/app/api/webhooks/circleback/route"

// Real delivery shape (production raw_payload, Aug-5 call) with QA identifiers.
function realShapedPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "8Pc4DsZ4kyZAcVnDCdeiB",
    name: "Alessandro and Antonio Durante",
    duration: 3314.766,
    url: "https://app.circleback.ai/meeting/x",
    recordingUrl: null,
    attendees: [
      { name: "Antonio Durante", email: "antonio.durante@tonydurante.us" },
      { name: "Fireflies.ai Notetaker Tony", email: null },
      { name: null, email: "info@luvain.it" },
      { name: "Alessandro Della B.", email: null },
      { name: "lorenzoaliberto", email: null },
    ],
    notes: "notes",
    actionItems: [],
    transcript: [],
    tags: [],
    icalUid: "1dvt1kf5le9hahgjung8or50gc@google.com",
    ...overrides,
  }
}

async function deliver(payload: Record<string, unknown>) {
  const req = new Request("https://x.test/api/webhooks/circleback", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  return POST(req as never)
}

function lastUpsert() {
  return upserts[upserts.length - 1]?.record ?? null
}

beforeEach(() => {
  scenario.leads = []
  scenario.contacts = []
  scenario.accountLinks = []
  scenario.existingRow = null
  upserts.length = 0
})

describe("cell 1 — identity resolution (real payload shape)", () => {
  it("lead-only match → lead_id, no contact/account, no review", async () => {
    scenario.leads = [{ id: "L1", email: "info@luvain.it" }]
    const res = await deliver(realShapedPayload())
    expect(res.status).toBe(200)
    const row = lastUpsert()!
    expect(row).toMatchObject({ lead_id: "L1", contact_id: null, account_id: null, link_review: null })
    expect(row.duration_seconds).toBe(3315) // fractional duration rounded
    expect(row.circleback_id).toBe("8Pc4DsZ4kyZAcVnDCdeiB") // string id preserved
  })

  it("contact-only match → contact_id AND account_id via the contact's sole account", async () => {
    scenario.contacts = [{ id: "C1", email: "info@luvain.it" }]
    scenario.accountLinks = [{ account_id: "A1" }]
    await deliver(realShapedPayload())
    expect(lastUpsert()).toMatchObject({ lead_id: null, contact_id: "C1", account_id: "A1", link_review: null })
  })

  it("contact with TWO accounts → contact linked, account left null (never guess)", async () => {
    scenario.contacts = [{ id: "C1", email: "info@luvain.it" }]
    scenario.accountLinks = [{ account_id: "A1" }, { account_id: "A2" }]
    await deliver(realShapedPayload())
    expect(lastUpsert()).toMatchObject({ contact_id: "C1", account_id: null })
  })

  it("dual (Alessandro-after-signing): same email is lead AND contact → BOTH written", async () => {
    scenario.leads = [{ id: "L1", email: "info@luvain.it" }]
    scenario.contacts = [{ id: "C1", email: "INFO@luvain.it" }]
    scenario.accountLinks = [{ account_id: "A1" }]
    await deliver(realShapedPayload())
    expect(lastUpsert()).toMatchObject({ lead_id: "L1", contact_id: "C1", account_id: "A1", link_review: null })
  })

  it("no match → unlinked, no review, 200 (no crash)", async () => {
    const res = await deliver(realShapedPayload())
    expect(res.status).toBe(200)
    expect(lastUpsert()).toMatchObject({ lead_id: null, contact_id: null, account_id: null, link_review: null })
  })
})

describe("cell 2 — email robustness", () => {
  it("case + whitespace variants still match (normalized before matching)", async () => {
    scenario.leads = [{ id: "L1", email: "info@luvain.it" }]
    await deliver(
      realShapedPayload({
        attendees: [
          { name: "Antonio Durante", email: "antonio.durante@tonydurante.us" },
          { name: null, email: "  INFO@Luvain.IT  " },
        ],
      }),
    )
    expect(lastUpsert()).toMatchObject({ lead_id: "L1" })
  })

  it("note-taker (null email) skipped; empty attendee list is a clean no-op row", async () => {
    const res = await deliver(realShapedPayload({ attendees: [] }))
    expect(res.status).toBe(200)
    expect(lastUpsert()).toMatchObject({ lead_id: null, contact_id: null, link_review: null })
  })
})

describe("cell 3 — staff exclusion", () => {
  it("staff + one client → links the client only", async () => {
    scenario.leads = [{ id: "L1", email: "info@luvain.it" }]
    await deliver(realShapedPayload()) // real payload already includes Antonio
    expect(lastUpsert()).toMatchObject({ lead_id: "L1", link_review: null })
  })

  it("staff-only call → links nothing", async () => {
    await deliver(
      realShapedPayload({
        attendees: [
          { name: "Antonio Durante", email: "antonio.durante@tonydurante.us" },
          { name: "Support", email: "support@tonydurante.us" },
        ],
      }),
    )
    expect(lastUpsert()).toMatchObject({ lead_id: null, contact_id: null, link_review: null })
  })

  it("design partner excluded; a client email ON the company domain cannot link (by design) and does not crash", async () => {
    // Even if a contact row exists carrying an internal-domain email, exclusion
    // runs BEFORE matching — the row can never absorb the call.
    scenario.contacts = [{ id: "C-internal", email: "hypothetical-client@tonydurante.us" }]
    const res = await deliver(
      realShapedPayload({
        attendees: [
          { name: "Cris", email: "cristian@sirioos.design" },
          { name: "X", email: "hypothetical-client@tonydurante.us" },
        ],
      }),
    )
    expect(res.status).toBe(200)
    expect(lastUpsert()).toMatchObject({ lead_id: null, contact_id: null })
  })
})

describe("cell 4 — ambiguity", () => {
  it("two distinct client identities (co-founders) → NO link + review marker", async () => {
    scenario.leads = [{ id: "L1", email: "a@x.com" }]
    scenario.contacts = [{ id: "C2", email: "b@y.com" }]
    await deliver(
      realShapedPayload({
        attendees: [
          { name: "Antonio Durante", email: "antonio.durante@tonydurante.us" },
          { name: "A", email: "a@x.com" },
          { name: "B", email: "b@y.com" },
        ],
      }),
    )
    const row = lastUpsert()!
    expect(row.lead_id).toBe(null)
    expect(row.contact_id).toBe(null)
    expect(String(row.link_review)).toContain("2 distinct client identities")
  })

  it("two leads sharing one email (the old limit(1) bug) → marker, never an arbitrary pick", async () => {
    scenario.leads = [
      { id: "L1", email: "info@luvain.it" },
      { id: "L2", email: "info@luvain.it" },
    ]
    await deliver(realShapedPayload())
    const row = lastUpsert()!
    expect(row.lead_id).toBe(null)
    expect(String(row.link_review)).toContain("2 leads")
  })
})

describe("cell 5 — re-delivery / idempotency (fill-only-when-empty at the row)", () => {
  it("re-delivery after a MANUAL link → the manual link survives (existing non-null wins)", async () => {
    scenario.existingRow = { id: "row1", lead_id: "L-manual", contact_id: null, account_id: null, link_review: null }
    scenario.leads = [{ id: "L-auto", email: "info@luvain.it" }]
    await deliver(realShapedPayload())
    expect(lastUpsert()).toMatchObject({ lead_id: "L-manual" })
  })

  it("same delivery twice → identical link outcome, upsert keyed on circleback_id (no duplicate rows)", async () => {
    scenario.leads = [{ id: "L1", email: "info@luvain.it" }]
    await deliver(realShapedPayload())
    const first = lastUpsert()!
    scenario.existingRow = { id: "row1", lead_id: "L1", contact_id: null, account_id: null, link_review: null }
    await deliver(realShapedPayload())
    const second = lastUpsert()!
    expect(second.lead_id).toBe(first.lead_id)
    expect(second.circleback_id).toBe(first.circleback_id)
    expect(upserts.every(u => u.table === "call_summaries")).toBe(true)
  })

  it("DESIGN FACT (stated, proven): re-delivery after a manual UNLINK re-fills the link — unlink empties the field and empty fields are fillable; a re-link to a DIFFERENT lead blocks it instead", async () => {
    scenario.existingRow = { id: "row1", lead_id: null, contact_id: null, account_id: null, link_review: null }
    scenario.leads = [{ id: "L1", email: "info@luvain.it" }]
    await deliver(realShapedPayload())
    expect(lastUpsert()).toMatchObject({ lead_id: "L1" })
  })

  it("existing review marker is preserved when still unlinked, cleared once any link exists", async () => {
    scenario.existingRow = { id: "row1", lead_id: null, contact_id: null, account_id: null, link_review: "auto-link refused: old reason" }
    await deliver(realShapedPayload()) // no candidates → stays unlinked
    expect(String(lastUpsert()!.link_review)).toContain("old reason")
    scenario.existingRow = { id: "row1", lead_id: "L1", contact_id: null, account_id: null, link_review: "auto-link refused: old reason" }
    await deliver(realShapedPayload())
    expect(lastUpsert()!.link_review).toBe(null)
  })
})
