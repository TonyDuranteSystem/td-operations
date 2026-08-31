/**
 * app/(dashboard)/accounts/actions.ts — disableAccountAutopay() +
 * sendAutopayEnrollmentLink() (dev job 10995181 follow-up, Finance summary
 * card). Covers: the staff "Turn off" action calling disableAutopayCard with
 * the dashboard actor (not "client") plus the real auth user id for the
 * retired note's attribution, both actions' explicit "not signed in" guard,
 * and the SIMPLIFIED "Send enrollment link" (2026-08-31 council review — no
 * longer creates a live Stripe object from the CRM at all; just points the
 * client to their own portal's self-service autopay button).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

let sessionUser: { id: string; email: string } | null = { id: "user-luca-uuid", email: "luca@tonydurante.us" }
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: sessionUser } }) },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
}))

const disableAutopayCardMock = vi.fn()
vi.mock("@/lib/operations/card-autopay", () => ({
  disableAutopayCard: (accountId: string, actor: string, deletedByUserId?: string) => disableAutopayCardMock(accountId, actor, deletedByUserId),
}))

let killSwitchEnabled = true
vi.mock("@/lib/payments/card-autopay-config", () => ({
  isCardAutopayEnabled: () => Promise.resolve(killSwitchEnabled),
}))

const resolveAdminReplyContactMock = vi.fn()
vi.mock("@/lib/portal/admin-send-scope", () => ({
  resolveAdminReplyContact: (accountId: string, replyToId: string | null) => resolveAdminReplyContactMock(accountId, replyToId),
}))

const createPortalNotificationMock = vi.fn()
const notifyClientOfAdminMessageMock = vi.fn()
vi.mock("@/lib/portal/notifications", () => ({
  createPortalNotification: (params: unknown) => { createPortalNotificationMock(params); return Promise.resolve() },
  notifyClientOfAdminMessage: (params: unknown) => { notifyClientOfAdminMessageMock(params); return Promise.resolve() },
}))

let accountRow: { autopay_card_enabled: boolean } | null = { autopay_card_enabled: false }
let contactRow: { language: string | null } | null = { language: null }
let portalMessagesInsertCalls: Array<Record<string, unknown>> = []
let portalMessagesInsertError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: accountRow, error: accountRow ? null : { message: "not found" } }) }) }) }
      }
      if (table === "contacts") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: contactRow, error: null }) }) }) }
      }
      if (table === "portal_messages") {
        return {
          insert: (payload: Record<string, unknown>) => {
            portalMessagesInsertCalls.push(payload)
            return Promise.resolve({ error: portalMessagesInsertError })
          },
        }
      }
      return { insert: () => Promise.resolve({ error: null }) }
    },
  },
}))

beforeEach(() => {
  disableAutopayCardMock.mockReset()
  resolveAdminReplyContactMock.mockReset()
  createPortalNotificationMock.mockReset()
  notifyClientOfAdminMessageMock.mockReset()
  killSwitchEnabled = true
  sessionUser = { id: "user-luca-uuid", email: "luca@tonydurante.us" }
  accountRow = { autopay_card_enabled: false }
  contactRow = { language: null }
  portalMessagesInsertCalls = []
  portalMessagesInsertError = null

  disableAutopayCardMock.mockResolvedValue({ ok: true })
  resolveAdminReplyContactMock.mockResolvedValue("contact-1")
})

describe("disableAccountAutopay", () => {
  it("turns autopay off tagging the dashboard user as actor, not the client, and passes the real user id through for the retired note's attribution", async () => {
    const { disableAccountAutopay } = await import("@/app/(dashboard)/accounts/actions")
    const result = await disableAccountAutopay("acct-1")
    expect(result.success).toBe(true)
    expect(disableAutopayCardMock).toHaveBeenCalledWith("acct-1", "dashboard:luca", "user-luca-uuid")
  })

  it("returns success:false with the operations-layer error when the disable fails", async () => {
    disableAutopayCardMock.mockResolvedValue({ ok: false, error: "Stripe detach failed" })
    const { disableAccountAutopay } = await import("@/app/(dashboard)/accounts/actions")
    const result = await disableAccountAutopay("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("Stripe detach failed")
  })

  it("refuses when there is no signed-in session, instead of proceeding as an unknown actor", async () => {
    sessionUser = null
    const { disableAccountAutopay } = await import("@/app/(dashboard)/accounts/actions")
    const result = await disableAccountAutopay("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("signed in")
    expect(disableAutopayCardMock).not.toHaveBeenCalled()
  })
})

describe("sendAutopayEnrollmentLink (simplified 2026-08-31 — no Stripe object created from the CRM)", () => {
  it("posts a portal-link message as an admin portal message, no Stripe customer/session involved", async () => {
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(true)
    expect(portalMessagesInsertCalls).toHaveLength(1)
    expect(portalMessagesInsertCalls[0]).toMatchObject({
      account_id: "acct-1",
      contact_id: "contact-1",
      sender_type: "admin",
      // portal_messages.sender_id is a UUID FK — must be the real auth user id,
      // never getDashboardActor()'s "dashboard:name" audit-log string.
      sender_id: "user-luca-uuid",
    })
    // Points to the client's own portal — no live payment credential minted.
    expect(String(portalMessagesInsertCalls[0].message)).toContain("/portal/invoices?tab=expenses")
    expect(String(portalMessagesInsertCalls[0].message)).not.toContain("checkout.stripe.com")
    expect(createPortalNotificationMock).toHaveBeenCalledTimes(1)
    // A dedicated topic so this doesn't share (and lose to) an unrelated
    // chat message's throttle window on the same account.
    expect(notifyClientOfAdminMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "autopay-enrollment" }),
    )
  })

  it("sends the Italian variant when the resolved contact's language is Italian", async () => {
    contactRow = { language: "Italian" }
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(true)
    expect(String(portalMessagesInsertCalls[0].message)).toContain("portale")
  })

  it("refuses when there is no signed-in session, before any write", async () => {
    sessionUser = null
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("signed in")
    expect(portalMessagesInsertCalls).toHaveLength(0)
  })

  it("refuses when the global autopay kill switch is off — avoids pointing the client to a dead-end portal button", async () => {
    killSwitchEnabled = false
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("switched off")
    expect(portalMessagesInsertCalls).toHaveLength(0)
  })

  it("refuses when the account is already enrolled", async () => {
    accountRow = { autopay_card_enabled: true }
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("already")
  })

  it("refuses when the account has no linked contact to send to, instead of reporting a false success", async () => {
    resolveAdminReplyContactMock.mockResolvedValue(null)
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("no linked contact")
  })

  it("fails when the portal_messages insert errors", async () => {
    portalMessagesInsertError = { message: "connection reset" }
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("connection reset")
    expect(createPortalNotificationMock).not.toHaveBeenCalled()
  })
})
