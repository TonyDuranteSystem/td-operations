/**
 * app/(dashboard)/accounts/actions.ts — disableAccountAutopay() +
 * sendAutopayEnrollmentLink() (dev job 10995181 follow-up, Finance summary
 * card). Covers: the staff "Turn off" action calling disableAutopayCard with
 * the dashboard actor (not "client"), and the "Send enrollment link" action's
 * full happy path + each Stripe-helper failure short-circuit.
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
  disableAutopayCard: (accountId: string, actor: string) => disableAutopayCardMock(accountId, actor),
  getOrCreateStripeCustomerForAccount: (accountId: string) => getOrCreateStripeCustomerForAccountMock(accountId),
  createAutopaySetupCheckoutSession: (params: unknown) => createAutopaySetupCheckoutSessionMock(params),
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

let portalMessagesInsertCalls: Array<Record<string, unknown>> = []
let portalMessagesInsertError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
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
  getOrCreateStripeCustomerForAccountMock.mockReset()
  createAutopaySetupCheckoutSessionMock.mockReset()
  resolveAdminReplyContactMock.mockReset()
  createPortalNotificationMock.mockReset()
  notifyClientOfAdminMessageMock.mockReset()
  portalMessagesInsertCalls = []
  portalMessagesInsertError = null

  disableAutopayCardMock.mockResolvedValue({ ok: true })
  getOrCreateStripeCustomerForAccountMock.mockResolvedValue({ customerId: "cus_123" })
  createAutopaySetupCheckoutSessionMock.mockResolvedValue({ url: "https://checkout.stripe.com/session-abc" })
  resolveAdminReplyContactMock.mockResolvedValue("contact-1")
})

describe("disableAccountAutopay", () => {
  it("turns autopay off tagging the dashboard user as actor, not the client", async () => {
    const { disableAccountAutopay } = await import("@/app/(dashboard)/accounts/actions")
    const result = await disableAccountAutopay("acct-1")
    expect(result.success).toBe(true)
    expect(disableAutopayCardMock).toHaveBeenCalledWith("acct-1", "dashboard:luca")
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
    expect(createPortalNotificationMock).toHaveBeenCalledTimes(1)
    expect(notifyClientOfAdminMessageMock).toHaveBeenCalledTimes(1)
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
