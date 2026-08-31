/**
 * lib/operations/autopay-webhook-completion.ts — extracted out of
 * app/api/webhooks/stripe/route.ts (2026-08-31, council review round 2) so
 * the Stripe-redelivery dedup guard has real test coverage. Before the
 * extraction, handleAutopaySetupCompleted was a private function inside a
 * route.ts file, which cannot export test-only helpers without breaking the
 * production build, and sandbox blocks /api/webhooks/* with a 503, so this
 * fix had NO verification path at all until now.
 *
 * Covers the actual bug-hunter blocker: a Stripe webhook redelivery of an
 * ALREADY-PROCESSED setup completion must not re-enable an account that was
 * disabled in between deliveries, using a card that may already be
 * detached. Dedup is keyed on the Checkout Session id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

let existingEventRow: { id: string } | null = null
const webhookEventsInsertCalls: Array<Record<string, unknown>> = []
const eqCalls: Array<[string, string]> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "webhook_events") {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col: string, val: string) => {
            eqCalls.push([col, val])
            return chain
          }),
          maybeSingle: vi.fn(() => Promise.resolve({ data: existingEventRow, error: null })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            webhookEventsInsertCalls.push(payload)
            return Promise.resolve({ data: null, error: null })
          }),
        }
        return chain
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  },
}))

const saveAutopayCardMock = vi.fn()
vi.mock("@/lib/operations/card-autopay", () => ({
  saveAutopayCard: (params: unknown) => saveAutopayCardMock(params),
}))

const setupIntentsRetrieveMock = vi.fn()
const paymentMethodsRetrieveMock = vi.fn()
vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    setupIntents: { retrieve: setupIntentsRetrieveMock },
    paymentMethods: { retrieve: paymentMethodsRetrieveMock },
  })),
}))

import { handleAutopaySetupCompleted } from "@/lib/operations/autopay-webhook-completion"

const session = {
  id: "cs_test_session_1",
  mode: "setup",
  setup_intent: "seti_1",
  customer: "cus_1",
  metadata: { account_id: "acc-1" },
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake"
  existingEventRow = null
  webhookEventsInsertCalls.length = 0
  eqCalls.length = 0
  saveAutopayCardMock.mockReset()
  setupIntentsRetrieveMock.mockReset()
  paymentMethodsRetrieveMock.mockReset()
  setupIntentsRetrieveMock.mockResolvedValue({ payment_method: "pm_1" })
  paymentMethodsRetrieveMock.mockResolvedValue({ card: { last4: "4242" } })
})

describe("handleAutopaySetupCompleted", () => {
  it("processes a first-time delivery normally: saves the card and marks the session processed", async () => {
    await handleAutopaySetupCompleted(session)

    expect(saveAutopayCardMock).toHaveBeenCalledWith({
      accountId: "acc-1",
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      last4: "4242",
    })
    expect(webhookEventsInsertCalls).toHaveLength(1)
    expect(webhookEventsInsertCalls[0]).toMatchObject({
      source: "stripe",
      event_type: "autopay_setup_completed",
      external_id: "cs_test_session_1",
    })
  })

  it("2026-08-31: skips a redelivery of the SAME session id — does not call saveAutopayCard again", async () => {
    existingEventRow = { id: "evt-1" }
    await handleAutopaySetupCompleted(session)

    expect(saveAutopayCardMock).not.toHaveBeenCalled()
    expect(webhookEventsInsertCalls).toHaveLength(0)
    // Confirms the dedup check itself is scoped to this exact session — not
    // a blanket "any autopay_setup_completed ever" check that would also
    // block legitimate future enrollments.
    expect(eqCalls).toContainEqual(["external_id", "cs_test_session_1"])
  })

  it("does NOT skip a genuinely new session id — dedup never falsely blocks a real re-enrollment", async () => {
    existingEventRow = null // no row matches THIS session id
    const newSession = { ...session, id: "cs_test_session_2" }
    await handleAutopaySetupCompleted(newSession)

    expect(saveAutopayCardMock).toHaveBeenCalledTimes(1)
    expect(webhookEventsInsertCalls).toHaveLength(1)
    expect(webhookEventsInsertCalls[0].external_id).toBe("cs_test_session_2")
  })

  it("does not mark the session processed if saveAutopayCard throws — a genuine failure must remain retryable", async () => {
    saveAutopayCardMock.mockRejectedValue(new Error("db down"))
    await handleAutopaySetupCompleted(session)
    expect(webhookEventsInsertCalls).toHaveLength(0)
  })

  it("does nothing (no dedup check, no save) when account_id metadata is missing", async () => {
    await handleAutopaySetupCompleted({ ...session, metadata: null })
    expect(saveAutopayCardMock).not.toHaveBeenCalled()
    expect(webhookEventsInsertCalls).toHaveLength(0)
  })

  it("does nothing when setup_intent or customer is missing from the session", async () => {
    await handleAutopaySetupCompleted({ ...session, setup_intent: null })
    expect(saveAutopayCardMock).not.toHaveBeenCalled()
  })
})
