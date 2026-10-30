/**
 * Creating the person for a payment. What must hold: never a second copy of someone who is already in the CRM
 * (by email, or by the same words in any order), never two people from a double click, and a retry after a
 * failure reuses its own leftover. Remove the name check and the "same words, other order" test fails; derive
 * the id differently per call and the double-click test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Call = { table: string; method: string; args: unknown[] }
let calls: Call[] = []
let ownRow: Record<string, unknown> | null
let nameRows: Array<Record<string, unknown>>
let insertResult: { data: Record<string, unknown> | null; error: { code?: string; message: string } | null }
let emailMatchId: string | null
let emailRow: Record<string, unknown> | null

vi.mock("@/lib/operations/find-contact-by-email", () => ({
  findContactIdByEmail: vi.fn(async () => emailMatchId),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let usedIn = false
      let usedIlike = false
      let isInsert = false
      const q: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          const name = String(prop)
          if (name === "then") {
            // a list read (name search)
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: nameRows, error: null }).then(res, rej)
          }
          if (name === "maybeSingle") {
            return () => {
              const idFilter = calls.filter((c) => c.method === "eq" && c.args[0] === "id").slice(-1)[0]
              if (idFilter && String(idFilter.args[1]).startsWith("5") === false && idFilter.args[1] === OWN_ID) return Promise.resolve({ data: ownRow, error: null })
              return Promise.resolve({ data: emailRow, error: null })
            }
          }
          if (name === "single") return () => Promise.resolve(insertResult)
          return (...args: unknown[]) => {
            calls.push({ table, method: name, args })
            if (name === "insert") isInsert = true
            if (name === "in") usedIn = true
            if (name === "ilike") usedIlike = true
            void usedIn; void usedIlike; void isInsert
            if (name === "limit") return Promise.resolve({ data: nameRows, error: null })
            if (name === "delete") return { eq: () => Promise.resolve({ error: null }) }
            return q
          }
        },
      })
      return q
    },
  },
}))

import { findOrCreatePayerContact, payerContactIdForFeed, nameKey, removeJustCreatedPayerContact, IN_PROGRESS_WINDOW_MS } from "@/lib/operations/feed-payer-contact"

const FEED_ID = "228b5a19-9a35-4221-84bc-1226d4a605c0"
const OWN_ID = payerContactIdForFeed(FEED_ID)

beforeEach(() => {
  calls = []
  ownRow = null
  nameRows = []
  emailMatchId = null
  emailRow = null
  insertResult = { data: { id: OWN_ID, full_name: "Simone Fattor" }, error: null }
})

describe("payerContactIdForFeed", () => {
  it("is a valid UUID, the same for the same payment every time, and different for another payment", () => {
    expect(OWN_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(payerContactIdForFeed(FEED_ID)).toBe(OWN_ID)
    expect(payerContactIdForFeed(FEED_ID.toUpperCase())).toBe(OWN_ID)
    expect(payerContactIdForFeed("ffffffff-0000-4000-8000-000000000000")).not.toBe(OWN_ID)
  })
})

describe("nameKey", () => {
  it("is the same for the same words in any order, case and spacing", () => {
    expect(nameKey("Simone  FATTOR")).toBe(nameKey("fattor simone"))
    expect(nameKey("Simone Fattor")).not.toBe(nameKey("Simone Fattori"))
  })
})

describe("findOrCreatePayerContact", () => {
  it("creates a plain person with the derived id, the typed email and a note saying where it came from", async () => {
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor", email: "S@Fattor.it" }, FEED_ID)
    expect(r).toEqual({ ok: true, contactId: OWN_ID, created: true, fullName: "Simone Fattor" })
    const row = calls.find((c) => c.method === "insert")!.args[0] as Record<string, unknown>
    expect(row).toMatchObject({ id: OWN_ID, full_name: "Simone Fattor", first_name: "Simone", last_name: "Fattor", email: "s@fattor.it" })
    expect(String(row.notes)).toMatch(/not a client or a lead/)
    // nothing about a company, a portal tier or a status is set — a plain person
    expect(Object.keys(row).sort()).toEqual(["email", "first_name", "full_name", "id", "last_name", "notes"])
  })

  it("refuses a bad name or email before touching the database", async () => {
    const r = await findOrCreatePayerContact({ full_name: "S", email: "" }, FEED_ID)
    expect(r).toMatchObject({ ok: false, kind: "invalid" })
    expect(calls).toEqual([])
  })

  it("does NOT create a second copy of someone whose email is already in the CRM — it names them", async () => {
    emailMatchId = "11111111-1111-4111-8111-111111111111"
    emailRow = { full_name: "Simone F.", email: "s@fattor.it" }
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor", email: "s@fattor.it" }, FEED_ID)
    expect(r).toMatchObject({ ok: false, kind: "exists", existing: { id: emailMatchId, name: "Simone F." } })
    expect(calls.some((c) => c.method === "insert")).toBe(false)
  })

  it("does NOT create a second copy when the same words exist in another order", async () => {
    nameRows = [{ id: "22222222-2222-4222-8222-222222222222", full_name: "Fattor Simone", email: null }]
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor" }, FEED_ID)
    expect(r).toMatchObject({ ok: false, kind: "exists", existing: { name: "Fattor Simone" } })
    expect(calls.some((c) => c.method === "insert")).toBe(false)
  })

  it("a similar but different name is not a duplicate", async () => {
    nameRows = [{ id: "22222222-2222-4222-8222-222222222222", full_name: "Simone Fattori", email: null }]
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor" }, FEED_ID)
    expect(r.ok).toBe(true)
  })

  it("a second request for the same payment (double click) loses the primary-key race and is told it is in progress", async () => {
    insertResult = { data: null, error: { code: "23505", message: "duplicate key" } }
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor" }, FEED_ID)
    expect(r).toMatchObject({ ok: false, kind: "in_progress" })
  })

  it("a recent record under the derived id means another request is working on it", async () => {
    ownRow = { id: OWN_ID, full_name: "Simone Fattor", created_at: new Date(Date.now() - 5_000).toISOString() }
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor" }, FEED_ID)
    expect(r).toMatchObject({ ok: false, kind: "in_progress" })
  })

  it("an OLD record under the derived id is our own leftover from a failed attempt: reused, not created again", async () => {
    ownRow = { id: OWN_ID, full_name: "Simone Fattor", created_at: new Date(Date.now() - IN_PROGRESS_WINDOW_MS - 60_000).toISOString() }
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor" }, FEED_ID)
    expect(r).toEqual({ ok: true, contactId: OWN_ID, created: false, fullName: "Simone Fattor" })
    expect(calls.some((c) => c.method === "insert")).toBe(false)
  })

  it("reports a database error plainly", async () => {
    insertResult = { data: null, error: { message: "boom" } }
    const r = await findOrCreatePayerContact({ full_name: "Simone Fattor" }, FEED_ID)
    expect(r).toMatchObject({ ok: false, kind: "failed", error: expect.stringMatching(/boom/) })
  })
})

describe("removeJustCreatedPayerContact", () => {
  it("deletes by id and says whether it worked", async () => {
    expect(await removeJustCreatedPayerContact(OWN_ID)).toBe(true)
  })
})
