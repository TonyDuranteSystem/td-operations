/**
 * app/(dashboard)/accounts/actions.ts — disableAccountAutopay() +
 * sendAutopayEnrollmentLink() (dev job 10995181 follow-up, Finance summary
 * card). Covers: the staff "Turn off" action calling disableAutopayCard with
 * the dashboard actor (not "client") plus the real auth user id for the
 * retired note's attribution, and "Send enrollment link"'s full happy path
 * plus every guard added in the 2026-08-30 council-review fix pass: the
 * global kill switch, the already-enrolled short-circuit, the
 * no-linked-contact refusal, the 24h duplicate-send guard, and the
 * Italian-language branch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "user-luca-uuid", email: "luca@tonydurante.us" } } }) },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
}))

const disableAutopayCardMock = vi.fn()
const getOrCreateStripeCustomerForAccountMock = vi.fn()
const createAutopaySetupCheckoutSessionMock = vi.fn()

vi.mock("@/lib/operations/card-autopay", () => ({
  disableAutopayCard: (accountId: string, actor: string, deletedByUserId?: string) => disableAutopayCardMock(accountId, actor, deletedByUserId),
  getOrCreateStripeCustomerForAccount: (accountId: string) => getOrCreateStripeCustomerForAccountMock(accountId),
  createAutopaySetupCheckoutSession: (params: unknown) => createAutopaySetupCheckoutSessionMock(params),
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

let accountRow: { autopay_card_enabled: boolean; account_type: string } | null = { autopay_card_enabled: false, account_type: "Client" }
let contactRow: { language: string | null } | null = { language: null }
let recentSendRow: { id: string } | null = null
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
          select: () => ({
            eq: () => ({
              eq: () => ({
                ilike: () => ({
                  is: () => ({
                    gte: () => ({
                      limit: () => ({
                        maybeSingle: () => Promise.resolve({ data: recentSendRow, error: null }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
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
  getOrCreateStripeCustomerForAccountMock.mockReset()
  createAutopaySetupCheckoutSessionMock.mockReset()
  resolveAdminReplyContactMock.mockReset()
  createPortalNotificationMock.mockReset()
  notifyClientOfAdminMessageMock.mockReset()
  killSwitchEnabled = true
  accountRow = { autopay_card_enabled: false, account_type: "Client" }
  contactRow = { language: null }
  recentSendRow = null
  portalMessagesInsertCalls = []
  portalMessagesInsertError = null

  disableAutopayCardMock.mockResolvedValue({ ok: true })
  getOrCreateStripeCustomerForAccountMock.mockResolvedValue({ customerId: "cus_123" })
  createAutopaySetupCheckoutSessionMock.mockResolvedValue({ url: "https://checkout.stripe.com/session-abc" })
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
})

describe("sendAutopayEnrollmentLink", () => {
  it("creates a Stripe customer + setup session and posts the enrollment link as an admin portal message", async () => {
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(true)
    expect(getOrCreateStripeCustomerForAccountMock).toHaveBeenCalledWith("acct-1")
    expect(createAutopaySetupCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1", customerId: "cus_123" }),
    )
    expect(portalMessagesInsertCalls).toHaveLength(1)
    expect(portalMessagesInsertCalls[0]).toMatchObject({
      account_id: "acct-1",
      contact_id: "contact-1",
      sender_type: "admin",
      // portal_messages.sender_id is a UUID FK — must be the real auth user id,
      // never getDashboardActor()'s "dashboard:name" audit-log string.
      sender_id: "user-luca-uuid",
    })
    expect(String(portalMessagesInsertCalls[0].message)).toContain("https://checkout.stripe.com/session-abc")
    // The fee waiver only ever applies going forward — the message must say so.
    expect(String(portalMessagesInsertCalls[0].message)).toContain("future invoices")
    expect(createPortalNotificationMock).toHaveBeenCalledTimes(1)
    expect(notifyClientOfAdminMessageMock).toHaveBeenCalledTimes(1)
  })

  it("sends the Italian variant when the resolved contact's language is Italian", async () => {
    contactRow = { language: "Italian" }
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(true)
    expect(String(portalMessagesInsertCalls[0].message)).toContain("future fatture")
  })

  it("refuses when the global autopay kill switch is off — the one enrollment path that must never bypass it", async () => {
    killSwitchEnabled = false
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("switched off")
    expect(getOrCreateStripeCustomerForAccountMock).not.toHaveBeenCalled()
    expect(portalMessagesInsertCalls).toHaveLength(0)
  })

  it("refuses when the account is already enrolled", async () => {
    accountRow = { autopay_card_enabled: true, account_type: "Client" }
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("already")
    expect(getOrCreateStripeCustomerForAccountMock).not.toHaveBeenCalled()
  })

  it("refuses when the account has no linked contact to send to, instead of reporting a false success", async () => {
    resolveAdminReplyContactMock.mockResolvedValue(null)
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("no linked contact")
    expect(getOrCreateStripeCustomerForAccountMock).not.toHaveBeenCalled()
  })

  it("refuses a repeat send within 24 hours instead of creating a duplicate Stripe session and message", async () => {
    recentSendRow = { id: "existing-msg" }
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("already sent")
    expect(getOrCreateStripeCustomerForAccountMock).not.toHaveBeenCalled()
  })

  it("fails without sending anything when the Stripe customer can't be created", async () => {
    getOrCreateStripeCustomerForAccountMock.mockResolvedValue({ error: "Account not found" })
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("Account not found")
    expect(createAutopaySetupCheckoutSessionMock).not.toHaveBeenCalled()
    expect(portalMessagesInsertCalls).toHaveLength(0)
  })

  it("fails without sending anything when the checkout session can't be created", async () => {
    createAutopaySetupCheckoutSessionMock.mockResolvedValue({ error: "STRIPE_SECRET_KEY not set" })
    const { sendAutopayEnrollmentLink } = await import("@/app/(dashboard)/accounts/actions")
    const result = await sendAutopayEnrollmentLink("acct-1")
    expect(result.success).toBe(false)
    expect(result.error).toContain("STRIPE_SECRET_KEY not set")
    expect(portalMessagesInsertCalls).toHaveLength(0)
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
