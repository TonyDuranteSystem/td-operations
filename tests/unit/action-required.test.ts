/**
 * Unit tests for lib/portal/action-required.ts
 *
 * Verifies the client action-required dispatch chokepoint:
 *  - requires a recipient (contact_id or account_id)
 *  - dedup window skips a duplicate dispatch entirely
 *  - chat message is clickable (absolute portal URL appended) and stamped
 *    with service_delivery_id
 *  - VISIBLE-THREAD RULE: an account hidden from the portal (status not
 *    Active/Suspended) must NOT carry the chat tag — personal thread instead
 *  - bell notification is created with suppressDigestEmail (no digest double)
 *  - immediate email respects the client's messy free-text language
 *  - notifySs4ReadyToSign only fires for awaiting_signature and targets the
 *    signer with the /portal/sign/ss4 deep link
 *  - never throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mutable fixtures shared with the mocked supabase client ──────────────────
interface Fixtures {
  dedupCount: number
  contact: { id: string; email: string | null; full_name: string | null; language: string | null } | null
  accountStatus: string | null
  accountContacts: Array<{ contacts: { id: string; email: string | null; full_name: string | null; language: string | null } }>
  ss4: { id: string; account_id: string | null; contact_id: string | null; company_name: string | null; status: string } | null
  chatInsertError: { message: string } | null
}
const fixtures: Fixtures = {
  dedupCount: 0,
  contact: null,
  accountStatus: "Active",
  accountContacts: [],
  ss4: null,
  chatInsertError: null,
}
const chatInserts: Array<Record<string, unknown>> = []
const emailSends: Array<Record<string, unknown>> = []
const notificationCalls: Array<Record<string, unknown>> = []

function resolveFor(table: string, op: string) {
  if (table === "portal_notifications") {
    return { data: null, error: null, count: fixtures.dedupCount }
  }
  if (table === "contacts") return { data: fixtures.contact, error: null }
  if (table === "accounts") return { data: fixtures.accountStatus ? { status: fixtures.accountStatus } : null, error: null }
  if (table === "account_contacts") return { data: fixtures.accountContacts, error: null }
  if (table === "ss4_applications") return { data: fixtures.ss4, error: null }
  if (table === "portal_messages") return { data: null, error: op === "insert" ? fixtures.chatInsertError : null }
  return { data: null, error: null }
}

function makeBuilder(table: string) {
  const state = { table, op: "select" }
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.gt = chain
  b.in = chain
  b.limit = chain
  b.order = chain
  b.insert = (payload: Record<string, unknown>) => {
    state.op = "insert"
    if (table === "portal_messages") chatInserts.push(payload)
    return b
  }
  b.maybeSingle = async () => resolveFor(state.table, state.op)
  b.single = async () => resolveFor(state.table, state.op)
  b.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolveFor(state.table, state.op)).then(onFulfilled)
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}))
vi.mock("@/lib/gmail", () => ({
  gmailPost: vi.fn(async (path: string, body: Record<string, unknown>) => {
    emailSends.push({ path, ...body })
    return {}
  }),
}))
vi.mock("@/lib/portal/notifications", () => ({
  createPortalNotification: vi.fn(async (params: Record<string, unknown>) => {
    notificationCalls.push(params)
  }),
}))
vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn(),
}))

import { notifyClientActionRequired, notifySs4ReadyToSign } from "@/lib/portal/action-required"

const TITLE = { en: "Sign your SS-4 — Acme LLC", it: "Firma il tuo SS-4 — Acme LLC" }
const MESSAGE = { en: "Please sign.", it: "Per favore firma." }

beforeEach(() => {
  fixtures.dedupCount = 0
  fixtures.contact = { id: "ctc-1", email: "client@example.com", full_name: "Michele Cotti", language: "Italian" }
  fixtures.accountStatus = "Active"
  fixtures.accountContacts = []
  fixtures.ss4 = null
  fixtures.chatInsertError = null
  chatInserts.length = 0
  emailSends.length = 0
  notificationCalls.length = 0
})

describe("notifyClientActionRequired", () => {
  it("skips everything when no recipient is given", async () => {
    const r = await notifyClientActionRequired({ title: TITLE, message: MESSAGE, link: "/portal/sign/ss4" })
    expect(r.dispatched).toBe(false)
    expect(r.chat).toContain("no recipient")
    expect(chatInserts).toHaveLength(0)
    expect(emailSends).toHaveLength(0)
    expect(notificationCalls).toHaveLength(0)
  })

  it("skips everything on a dedup hit (double-click guard)", async () => {
    fixtures.dedupCount = 1
    const r = await notifyClientActionRequired({
      contact_id: "ctc-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/sign/ss4",
    })
    expect(r.dispatched).toBe(false)
    expect(r.email).toContain("duplicate")
    expect(chatInserts).toHaveLength(0)
    expect(emailSends).toHaveLength(0)
  })

  it("dispatches all three channels with a clickable link and Italian copy", async () => {
    const r = await notifyClientActionRequired({
      contact_id: "ctc-1",
      account_id: "acc-1",
      service_delivery_id: "sd-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/sign/ss4",
    })
    expect(r.dispatched).toBe(true)
    expect(r.chat).toBe("ok")
    expect(r.notification).toBe("ok")
    expect(r.email).toContain("ok")

    // Chat: Italian body (language "Italian" → it), absolute URL appended,
    // SD-stamped, admin sender, account tag kept (status Active).
    expect(chatInserts).toHaveLength(1)
    const chat = chatInserts[0]
    expect(chat.message).toContain("Per favore firma.")
    expect(chat.message).toContain("/portal/sign/ss4")
    expect(String(chat.message)).toMatch(/https?:\/\//)
    expect(chat.service_delivery_id).toBe("sd-1")
    expect(chat.account_id).toBe("acc-1")
    expect(chat.contact_id).toBe("ctc-1")
    expect(chat.sender_type).toBe("admin")

    // Bell: digest email suppressed (we email directly), relative link.
    expect(notificationCalls).toHaveLength(1)
    expect(notificationCalls[0].suppressDigestEmail).toBe(true)
    expect(notificationCalls[0].link).toBe("/portal/sign/ss4")
    expect(notificationCalls[0].type).toBe("action_required")
    expect(notificationCalls[0].title).toBe(TITLE.it)

    // Email: exactly one immediate send.
    expect(emailSends).toHaveLength(1)
  })

  it("VISIBLE-THREAD RULE: hidden account (Pending Formation) → personal thread tag", async () => {
    fixtures.accountStatus = "Pending Formation"
    await notifyClientActionRequired({
      contact_id: "ctc-1",
      account_id: "acc-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/sign/ss4",
    })
    expect(chatInserts).toHaveLength(1)
    expect(chatInserts[0].account_id).toBeNull() // NOT tagged to the invisible account
    expect(chatInserts[0].contact_id).toBe("ctc-1")
  })

  it("uses English copy for an English client", async () => {
    fixtures.contact = { id: "ctc-1", email: "client@example.com", full_name: "John Doe", language: "English" }
    await notifyClientActionRequired({
      contact_id: "ctc-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/sign/ss4",
    })
    expect(chatInserts[0].message).toContain("Please sign.")
    expect(notificationCalls[0].title).toBe(TITLE.en)
  })

  it("skipEmail: chat + bell dispatch, email deliberately not sent", async () => {
    const r = await notifyClientActionRequired({
      contact_id: "ctc-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/invoices?inv=pay-1",
      skipEmail: true,
    })
    expect(r.dispatched).toBe(true)
    expect(r.chat).toBe("ok")
    expect(r.notification).toBe("ok")
    expect(r.email).toContain("caller sends its own email")
    expect(emailSends).toHaveLength(0)
  })

  it("still sends chat + bell when the contact has no email", async () => {
    fixtures.contact = { id: "ctc-1", email: null, full_name: "No Email", language: null }
    const r = await notifyClientActionRequired({
      contact_id: "ctc-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/sign/ss4",
    })
    expect(r.chat).toBe("ok")
    expect(r.notification).toBe("ok")
    expect(r.email).toContain("no recipient email")
    expect(emailSends).toHaveLength(0)
  })

  it("a chat failure never blocks the other channels and never throws", async () => {
    fixtures.chatInsertError = { message: "insert exploded" }
    const r = await notifyClientActionRequired({
      contact_id: "ctc-1",
      title: TITLE,
      message: MESSAGE,
      link: "/portal/sign/ss4",
    })
    expect(r.chat).toContain("insert exploded")
    expect(r.notification).toBe("ok")
    expect(r.email).toContain("ok")
  })
})

describe("notifySs4ReadyToSign", () => {
  it("skips when the SS-4 is not awaiting_signature (draft)", async () => {
    fixtures.ss4 = { id: "ss4-1", account_id: "acc-1", contact_id: "ctc-1", company_name: "Acme LLC", status: "draft" }
    const r = await notifySs4ReadyToSign({ ss4Id: "ss4-1" })
    expect(r.dispatched).toBe(false)
    expect(r.chat).toContain("not awaiting_signature")
    expect(chatInserts).toHaveLength(0)
  })

  it("targets the SIGNER with the /portal/sign/ss4 deep link when awaiting", async () => {
    fixtures.ss4 = { id: "ss4-1", account_id: "acc-1", contact_id: "ctc-1", company_name: "Acme LLC", status: "awaiting_signature" }
    const r = await notifySs4ReadyToSign({ ss4Id: "ss4-1", serviceDeliveryId: "sd-9" })
    expect(r.dispatched).toBe(true)
    expect(chatInserts).toHaveLength(1)
    expect(chatInserts[0].contact_id).toBe("ctc-1") // the signer, not the whole account
    expect(chatInserts[0].service_delivery_id).toBe("sd-9")
    expect(String(chatInserts[0].message)).toContain("/portal/sign/ss4")
    expect(notificationCalls[0].title).toContain("Acme LLC")
  })

  it("never throws when the SS-4 row is missing", async () => {
    fixtures.ss4 = null
    const r = await notifySs4ReadyToSign({ ss4Id: "gone" })
    expect(r.dispatched).toBe(false)
  })
})
