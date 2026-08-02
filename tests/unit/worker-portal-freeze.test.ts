import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The Inbox worker prepares a PORTAL CHAT message; a human Confirm delivers it.
 *
 * These tests pin the locks that make that safe. The email path froze its recipient
 * at draft time, so a click there only approves what was already decided. Here the
 * staff member picks the client ON THE CARD, so the recipient arrives from a browser
 * at claim time — on a client-facing send. Everything below exists because of that.
 */

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  claimed: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  contact: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  // THE REAL SUCCESS STRING from sendPortalMessageFromWorker. Previously a fabricated
  // "…— client notified by email." that production cannot produce — a test asserting on
  // an invented return value proves nothing about the code it guards.
  sendResult: "✅ Portal message sent to Acme LLC. id=msg-1 at 2026-08-01T00:00:00Z",
  sendArgs: null as Record<string, unknown> | null,
}))

vi.mock("@/lib/supabase-admin", () => {
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {}
    let isUpdate = false
    b.from = () => b
    b.select = () => b
    b.eq = () => b
    b.neq = () => b
    b.update = (patch: Record<string, unknown>) => {
      isUpdate = true
      state.updates.push({ table, ...patch })
      return b
    }
    b.maybeSingle = async () => {
      if (table === "accounts") return { data: state.account }
      if (table === "contacts") return { data: state.contact }
      return { data: state.row }
    }
    b.single = async () => ({ data: isUpdate ? state.claimed : state.row })
    b.then = (resolve: (v: unknown) => void) => Promise.resolve({ error: null }).then(resolve)
    return b
  }
  return { supabaseAdmin: { from: (t: string) => makeBuilder(t) } }
})

vi.mock("@/lib/inbox/worker-email-send", () => ({
  PREPARED_SEND_TTL_MS: 30 * 60 * 1000,
  supersedeEarlierDrafts: vi.fn(),
}))

vi.mock("@/lib/ai-agent/worker-tools", () => ({
  sendPortalMessageFromWorker: async (args: Record<string, unknown>) => {
    state.sendArgs = args
    return state.sendResult
  },
}))

import { confirmPortalSend } from "@/lib/inbox/worker-portal-freeze"

const FRESH = { id: "prep-1", body: "Please upload the statements.", created_at: new Date().toISOString() }

const base = {
  preparedId: "prep-1",
  actorEmail: "luca@tonydurante.us",
  rowActor: "crm-inbox:luca@tonydurante.us",
  action: "confirm" as const,
  accountId: null as string | null,
  contactId: null as string | null,
}

beforeEach(() => {
  state.row = { ...FRESH, kind: "portal", status: "pending", actor: base.rowActor }
  state.claimed = { ...FRESH }
  state.account = { id: "acct-1", company_name: "LUMA Beauty Global LLC" }
  state.contact = { id: "contact-1", full_name: "Adam Mihaly" }
  state.updates = []
  state.sendResult = "✅ Portal message sent to LUMA Beauty Global LLC. id=msg-1 at 2026-08-01T00:00:00Z"
  state.sendArgs = null
})

describe("confirmPortalSend — who may confirm", () => {
  it("REFUSES a confirm by someone other than the staff member who prepared it", async () => {
    // On the email path this would be harmless — the recipient is frozen, so a
    // colleague's click sends the same text to the same address. Here the confirmer
    // SUPPLIES the recipient, so an unbound prepared id is a "deliver this text to any
    // client I choose" primitive keyed by a uuid. In Team Chat that uuid is written
    // into a message every person in the channel can see.
    const r = await confirmPortalSend({ ...base, actorEmail: "antonio@tonydurante.us", accountId: "acct-1" })
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(403)
    expect(state.sendArgs).toBeNull()
  })

  it("matches the actor across surface prefixes, not on the raw string", async () => {
    // Actors are namespaced per surface (crm-inbox:, crm-portal:, crm-sidebar:,
    // team-chat:). Comparing the whole string would 403 every legitimate confirm.
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(true)
  })
})

describe("confirmPortalSend — which client", () => {
  it("REFUSES with no client chosen", async () => {
    const r = await confirmPortalSend({ ...base })
    expect(r.ok).toBe(false)
    expect(state.sendArgs).toBeNull()
  })

  it("REFUSES when both a company and a person are supplied", async () => {
    // The card offers ONE target, and the choice decides who can see the message:
    // a company message is visible to every member, a person's lands in their own
    // chat. Silently preferring one over the other would route it somewhere the
    // staff member did not pick.
    const r = await confirmPortalSend({ ...base, accountId: "acct-1", contactId: "contact-1" })
    expect(r.ok).toBe(false)
    expect(state.sendArgs).toBeNull()
  })

  it("REFUSES a company id that no longer exists — the id came from a browser", async () => {
    state.account = null
    const r = await confirmPortalSend({ ...base, accountId: "gone" })
    expect(r.ok).toBe(false)
    expect(state.sendArgs).toBeNull()
  })

  it("sends to the EXACT target picked — a company is never narrowed to one member", async () => {
    // Antonio, 2026-07-31: "If Luca will choose company, the message will go to the
    // company! Stop!" Narrowing also silently limits the notification to a single
    // member, because the notifier checks for a named person before a company.
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(true)
    expect(state.sendArgs).toMatchObject({ account_id: "acct-1", exact_recipient: true })
    expect(state.sendArgs?.contact_id).toBeUndefined()
  })

  it("records WHO WAS CONFIRMED on the row, not who the worker proposed", async () => {
    await confirmPortalSend({ ...base, accountId: "acct-1" })
    const claim = state.updates.find(u => u.status === "sent")
    expect(claim).toMatchObject({ portal_account_id: "acct-1", portal_contact_id: null })
  })
})

describe("confirmPortalSend — staleness and failure", () => {
  it("REFUSES a draft older than the TTL and cancels it", async () => {
    // The email dispatcher enforces this inside itself, so the portal path inherits
    // nothing. A card left open all morning would otherwise deliver news the client
    // has long since had.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    state.claimed = { ...FRESH, created_at: old }
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(false)
    expect(state.sendArgs).toBeNull()
    expect(state.updates.some(u => u.status === "cancelled")).toBe(true)
  })

  it("ROLLS BACK when the send helper reports failure as a STRING", async () => {
    // That helper returns errors as text rather than throwing, which is precisely how
    // its failures have been discarded before. A failed send must leave the row
    // re-sendable, not marked sent.
    state.sendResult = "❌ Failed to send portal message: insert denied"
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(false)
    expect(state.updates.some(u => u.status === "pending")).toBe(true)
  })

  it("treats '✅ Already sent (duplicate)' as NOT sent — it reads like success and posts nothing", async () => {
    state.sendResult = "✅ Already sent (duplicate within 2 min) — no new message posted. id=x"
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(false)
    expect(state.updates.some(u => u.status === "pending")).toBe(true)
  })

  it("REFUSES a row already sent or cancelled", async () => {
    state.claimed = null // the guarded pending→sent claim matched nothing
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(409)
    expect(state.sendArgs).toBeNull()
  })
})

describe("confirmPortalSend — what the staff member is told", () => {
  it("says 'unknown' about the client email rather than guessing — it is not knowable here", async () => {
    // THIS TEST USED TO ASSERT "emailed" AND WAS WORTHLESS. Its mock returned an
    // invented string containing the word "notified"; the code matched on that word;
    // production's real string ("✅ Portal message sent to <name>. id=… at …") does
    // not contain it. So the check passed while the shipped behaviour reported "no
    // email went out" on EVERY send — sending staff to chase clients by Gmail about
    // messages the client had already been emailed about.
    //
    // The deeper fact: the client notification is fire-and-forget inside the send
    // helper, so its outcome never comes back here. "Unknown" is the only honest
    // answer, and the panel now says nothing about email rather than guessing.
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(true)
    if (r.ok && "notified" in r) expect(r.notified).toBe("unknown")
  })

  it("REGRESSION GUARD: the mock's success string is the one production returns", async () => {
    // The bug above was invisible because the mock and the real function disagreed.
    // If the success wording ever changes, `delivered` stops recognising a real send
    // and every confirm rolls back — so pin the shape the code keys on.
    expect(state.sendResult.startsWith("✅ Portal message sent to")).toBe(true)
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    expect(r.ok).toBe(true)
  })

  it("names the recipient it actually validated", async () => {
    const r = await confirmPortalSend({ ...base, accountId: "acct-1" })
    if (r.ok && "recipientName" in r) expect(r.recipientName).toBe("LUMA Beauty Global LLC")
  })

  it("cancel never sends", async () => {
    const r = await confirmPortalSend({ ...base, action: "cancel", accountId: "acct-1" })
    expect(r.ok).toBe(true)
    expect(state.sendArgs).toBeNull()
    expect(state.updates.some(u => u.status === "cancelled")).toBe(true)
  })
})
