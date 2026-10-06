/**
 * /api/inbox/ai-suggest — the reply composer's one AI button (dev job bbc70ff8).
 *
 * The promises under test:
 *   • POLISH sends ONLY the typed draft to the model. It never reads Gmail, the CRM or the knowledge base —
 *     nothing to invent a private office or a price from (the 2026-10-06 incident).
 *   • A polish the validator rejects is a 422 and the draft is never returned.
 *   • An unknown mode is a 400 — it must never fall through to the other mode.
 *   • The personal mailbox is admin-only, checked BEFORE any read.
 *   • DRAFT never feeds the model the EIN or payments, and a sender header cannot reach the database filter raw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextRequest } from "next/server"

const callAIMock = vi.fn()
vi.mock("@/lib/portal/ai-provider", () => ({ callAI: (...a: unknown[]) => callAIMock(...a) }))

const gmailGetMock = vi.fn()
vi.mock("@/lib/gmail", () => ({
  gmailGet: (...a: unknown[]) => gmailGetMock(...a),
  extractBody: (payload: { body?: string }) => payload?.body ?? "",
  getHeader: (headers: Array<{ name: string; value: string }>, name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null,
  isOwnMailboxAddress: (from: string) => /@tonydurante\.us/i.test(from),
}))

const fetchKBMock = vi.fn(async () => "")
vi.mock("@/lib/portal/kb-context", () => ({
  fetchKBContext: (...a: unknown[]) => fetchKBMock(...a),
  buildKBQuery: () => "q",
}))

// supabaseAdmin: records every table touched and every .or() filter string.
const tablesTouched: string[] = []
const orFilters: string[] = []
let contactRow: unknown = null
function builder(table: string) {
  tablesTouched.push(table)
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.in = chain
  b.order = chain
  b.limit = chain
  b.or = (f: string) => { orFilters.push(f); return b }
  b.maybeSingle = async () => ({ data: table === "contacts" ? contactRow : null })
  b.single = async () => ({ data: table === "accounts" ? { company_name: "Fresh Legal Group LLC", entity_type: "SMLLC", state_of_formation: "Wyoming", ein_number: "61-2317600" } : null })
  b.then = (resolve: (v: unknown) => void) => resolve({ data: table === "service_deliveries" ? [{ service_name: "Registered Agent", status: "active" }] : [] })
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

let currentUser: { id: string } | null = { id: "staff-1" }
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}))
vi.mock("@/lib/auth", () => ({ isDashboardUser: () => true }))

let mailboxAllowed = true
const checkMailboxAccessMock = vi.fn(async () => mailboxAllowed)
vi.mock("@/lib/inbox/mailbox-access", () => ({ checkMailboxAccess: (...a: unknown[]) => checkMailboxAccessMock(...a) }))

let rateAllowed = true
vi.mock("@/lib/portal/rate-limit", () => ({
  checkRateLimit: () => (rateAllowed ? { allowed: true } : { allowed: false, retryAfter: 7 }),
}))

import { POST } from "../../app/api/inbox/ai-suggest/route"

const MICHAEL_DRAFT = "Hi Michael,\n\nThanks for signing — please find the countersigned amendment attached. That's all sorted on the lease side.\n\nI'm considering to not give my address as standalone service anymore\nBest,\nTony"

function req(body: unknown): NextRequest {
  return new Request("http://localhost/api/inbox/ai-suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  tablesTouched.length = 0
  orFilters.length = 0
  contactRow = null
  currentUser = { id: "staff-1" }
  mailboxAllowed = true
  rateAllowed = true
  process.env.ANTHROPIC_API_KEY = "test-key"
})

describe("POLISH mode", () => {
  it("sends ONLY the draft to the model and touches no Gmail, CRM or knowledge base", async () => {
    callAIMock.mockResolvedValue({ text: `<draft>\n${MICHAEL_DRAFT.replace("Thanks for signing —", "Thanks for signing.")}\n</draft>`, provider: "anthropic" })
    const res = await POST(req({ mode: "polish", mailbox: "support", draft: MICHAEL_DRAFT }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe("polish")
    expect(body.result).toContain("countersigned amendment")

    expect(callAIMock).toHaveBeenCalledTimes(1)
    const arg = callAIMock.mock.calls[0][0] as { systemPrompt: string; userPrompt: string; maxTokens: number }
    expect(arg.userPrompt).toBe(`<draft>\n${MICHAEL_DRAFT}\n</draft>`)
    // Nothing else could have reached the model — and nothing else was even read:
    expect(arg.systemPrompt).not.toMatch(/Interactive Brokers|private office|full office|EIN|payment/i)
    expect(gmailGetMock).not.toHaveBeenCalled()
    expect(fetchKBMock).not.toHaveBeenCalled()
    expect(tablesTouched).toEqual([])
  })

  it("REJECTS (422) the incident's rewrite — a different email promising an office and pricing — and returns no text", async () => {
    callAIMock.mockResolvedValue({
      text: `<draft>\nHi Michael,\n\nThanks for signing and returning the amendment. I've countersigned it and attached the fully executed copy for your records.\n\nOn the full office question — yes, we do have private office space that clients can physically use. This would be a proper, dedicated office address rather than a suite/mailbox address, which should satisfy Interactive Brokers' requirements. I'll put together the details and pricing for you and follow up shortly.\n\nBest,\nTony\n</draft>`,
      provider: "anthropic",
    })
    const res = await POST(req({ mode: "polish", draft: MICHAEL_DRAFT }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/left as it is/)
    expect(body.result).toBeUndefined()
  })

  it("scales the token budget to the draft instead of a fixed 600", async () => {
    const long = "This is a sentence about the lease. ".repeat(60)
    callAIMock.mockResolvedValue({ text: `<draft>\n${long}\n</draft>`, provider: "anthropic" })
    await POST(req({ mode: "polish", draft: long }))
    expect((callAIMock.mock.calls[0][0] as { maxTokens: number }).maxTokens).toBeGreaterThan(600)
  })

  it("refuses an empty draft (400) and a draft over the limit (400) without calling the model", async () => {
    const a = await POST(req({ mode: "polish", draft: "   " }))
    expect(a.status).toBe(400)
    const b = await POST(req({ mode: "polish", draft: "x".repeat(6001) }))
    expect(b.status).toBe(400)
    expect((await b.json()).code).toBe("too_long")
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it("reports changed:false when the model hands the text back untouched", async () => {
    callAIMock.mockResolvedValue({ text: `<draft>\n${MICHAEL_DRAFT}\n</draft>`, provider: "anthropic" })
    const res = await POST(req({ mode: "polish", draft: MICHAEL_DRAFT }))
    expect((await res.json()).changed).toBe(false)
  })
})

describe("request validation and access", () => {
  it("rejects an unknown or missing mode (400) — never falls through to the other mode", async () => {
    for (const mode of [undefined, "write", "improve", "Polish", ""]) {
      const res = await POST(req({ mode, draft: "hello", threadId: "t1" }))
      expect(res.status).toBe(400)
    }
    expect(callAIMock).not.toHaveBeenCalled()
    expect(gmailGetMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed body and an unknown mailbox", async () => {
    expect((await POST(req("not json"))).status).toBe(400)
    expect((await POST(req({ mode: "polish", draft: "hi there", mailbox: "someone-else" }))).status).toBe(400)
  })

  it("403s the personal mailbox for a non-admin BEFORE any model call or read", async () => {
    mailboxAllowed = false
    const res = await POST(req({ mode: "draft", threadId: "t1", mailbox: "antonio" }))
    expect(res.status).toBe(403)
    expect(checkMailboxAccessMock).toHaveBeenCalledWith("antonio")
    expect(gmailGetMock).not.toHaveBeenCalled()
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it("403s with no signed-in user", async () => {
    currentUser = null
    expect((await POST(req({ mode: "polish", draft: "hi there" }))).status).toBe(403)
  })

  it("429s with a plain 'wait N seconds' message, per staff member", async () => {
    rateAllowed = false
    const res = await POST(req({ mode: "polish", draft: "hi there" }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toMatch(/wait 7 seconds/)
    expect(res.headers.get("Retry-After")).toBe("7")
    expect(callAIMock).not.toHaveBeenCalled()
  })
})

describe("DRAFT mode", () => {
  function thread(from: string) {
    return {
      messages: [
        {
          id: "m1",
          payload: {
            headers: [{ name: "From", value: from }, { name: "Subject", value: "Introduction and Private Office Enquiry" }],
            body: "Hi Tony, could you let us know the cost of a full office?",
          },
        },
      ],
    }
  }

  it("never feeds the model the EIN or payments, and says never to state prices", async () => {
    gmailGetMock.mockResolvedValue(thread("Michael Darby <michael@fresh-ops.com>"))
    contactRow = { id: "c1", full_name: "Michael", email: "michael@fresh-ops.com", account_contacts: [{ account_id: "a1" }] }
    callAIMock.mockResolvedValue({ text: "Hi Michael,\n\nI'll come back to you on the office question. [confirm price]\n\nBest,\nTony", provider: "anthropic" })

    const res = await POST(req({ mode: "draft", threadId: "t1", mailbox: "support" }))
    expect(res.status).toBe(200)
    const arg = callAIMock.mock.calls[0][0] as { systemPrompt: string; userPrompt: string }
    expect(arg.systemPrompt).toContain("Company: Fresh Legal Group LLC")
    expect(arg.systemPrompt).not.toContain("61-2317600")
    expect(arg.systemPrompt).not.toMatch(/EIN/)
    expect(tablesTouched).not.toContain("payments")
    expect(arg.systemPrompt).toMatch(/NEVER state or imply a price, fee, amount/)
    expect((await res.json()).mode).toBe("draft")
  })

  it("reads the thread from the mailbox the composer says (antonio@) — the old client never sent it", async () => {
    gmailGetMock.mockResolvedValue(thread("Michael Darby <michael@fresh-ops.com>"))
    callAIMock.mockResolvedValue({ text: "Hi Michael,\n\nThanks.\n\nBest,\nTony", provider: "anthropic" })
    await POST(req({ mode: "draft", threadId: "t1", mailbox: "antonio" }))
    expect(gmailGetMock.mock.calls[0][2]).toBe("antonio.durante@tonydurante.us")
  })

  it("keeps a hostile From header out of the database filter", async () => {
    gmailGetMock.mockResolvedValue(thread('"x" <a,id.not.is.null>'))
    callAIMock.mockResolvedValue({ text: "Hi,\n\nThanks.\n\nBest,\nTony", provider: "anthropic" })
    await POST(req({ mode: "draft", threadId: "t1" }))
    expect(orFilters).toEqual([])
    expect(tablesTouched).not.toContain("contacts")
  })

  it("gives NO company context to a person linked to several companies (guessing the first was wrong)", async () => {
    gmailGetMock.mockResolvedValue(thread("Michael Darby <michael@fresh-ops.com>"))
    contactRow = { id: "c1", full_name: "Michael", email: "michael@fresh-ops.com", account_contacts: [{ account_id: "a1" }, { account_id: "a2" }] }
    callAIMock.mockResolvedValue({ text: "Hi Michael,\n\nThanks.\n\nBest,\nTony", provider: "anthropic" })
    await POST(req({ mode: "draft", threadId: "t1" }))
    expect((callAIMock.mock.calls[0][0] as { systemPrompt: string }).systemPrompt).not.toContain("Company:")
    expect(tablesTouched).not.toContain("accounts")
  })

  it("returns plain-language 404 / 502 when the thread cannot be read", async () => {
    gmailGetMock.mockResolvedValue({ messages: [] })
    const a = await POST(req({ mode: "draft", threadId: "t1", mailbox: "antonio" }))
    expect(a.status).toBe(404)
    expect((await a.json()).error).toMatch(/antonio@ mailbox/)
    gmailGetMock.mockRejectedValue(new Error("boom"))
    const b = await POST(req({ mode: "draft", threadId: "t1" }))
    expect(b.status).toBe(502)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it("requires a threadId", async () => {
    expect((await POST(req({ mode: "draft" }))).status).toBe(400)
  })

  it("cleans a lead-in line and bold markers from the drafted reply", async () => {
    gmailGetMock.mockResolvedValue(thread("Michael Darby <michael@fresh-ops.com>"))
    callAIMock.mockResolvedValue({ text: "Here's a draft reply:\nHi Michael,\n\nPlease see the **attached** file.\n\nBest,\nTony", provider: "anthropic" })
    const body = await (await POST(req({ mode: "draft", threadId: "t1" }))).json()
    expect(body.result).toBe("Hi Michael,\n\nPlease see the attached file.\n\nBest,\nTony")
  })
})

describe("AI failures are plain language, not silence", () => {
  it("returns a readable 500 when the model call throws", async () => {
    callAIMock.mockRejectedValue(new Error("upstream down"))
    const res = await POST(req({ mode: "polish", draft: "hello there my friend" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/AI is unavailable/)
  })
})
