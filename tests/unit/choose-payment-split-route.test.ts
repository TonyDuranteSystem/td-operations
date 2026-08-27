/**
 * /api/offers/choose-payment-split — regression tests for three real bugs found
 * by the bug-hunter's full E2E QA pass (2026-08-27), all confirmed live on
 * sandbox before being fixed here:
 *
 * 1. Neither branch persisted `selected_services` in the same write as the
 *    choice. The offer page's post-choice reload (`loadOffer`) then found no
 *    stored selection, fell back to the RECOMMENDED defaults, and silently
 *    reverted a client's actual add-on selection out from under an already-
 *    locked plan sized for the real one — a signed contract could end up
 *    stating a fee and a schedule that disagree with each other.
 * 2. The "full" branch never cleared a pre-existing `payment_plan`. A
 *    staff-authored plan and `allow_split_payment_choice` are only kept
 *    mutually exclusive by the Create Offer dialog's UI, not the database, so
 *    a client explicitly choosing "pay in full" could still be billed only a
 *    stale plan's first part at signing.
 * 3. A direct call against a multi-option offer with no package locked yet
 *    would compute the split against the offer's placeholder top-level
 *    services/cost_summary instead of refusing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/esign/access-guard", () => ({ accessCodeError: () => null }))
vi.mock("@/lib/portal/office-hours", () => ({ getOfficeDateString: () => "2026-08-27" }))

let offerFixture: Record<string, unknown> = {}
let lastUpdatePatch: Record<string, unknown> | null = null
let updateResult: { data: unknown; error: { message: string } | null } = { data: [{ token: "t1" }], error: null }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "offers") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: offerFixture, error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          lastUpdatePatch = patch
          const chain: Record<string, unknown> = {}
          chain.eq = () => chain
          chain.is = () => chain
          chain.select = () => Promise.resolve(updateResult)
          return chain
        },
      }
    },
  },
}))

import { POST } from "@/app/api/offers/choose-payment-split/route"

function baseOffer(overrides: Record<string, unknown> = {}) {
  return {
    token: "t1",
    access_code: "code-1",
    status: "sent",
    services: [{ name: "Company Formation", price: "$2,000" }],
    cost_summary: [{ label: "Setup Fee", total: "$2,000", items: [{ name: "Company Formation", price: "$2,000" }] }],
    selected_services: null,
    currency: "USD",
    credit_amount: null,
    allow_split_payment_choice: true,
    payment_plan: null,
    payment_choice_made_at: null,
    packages: null,
    package_locked_at: null,
    ...overrides,
  }
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/offers/choose-payment-split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("choose-payment-split — selected_services persists in BOTH branches (bug 1)", () => {
  beforeEach(() => {
    lastUpdatePatch = null
    updateResult = { data: [{ token: "t1" }], error: null }
  })

  it("full: writes the caller's live selection, not just the choice timestamp", async () => {
    offerFixture = baseOffer()
    const res = await POST(makeRequest({
      token: "t1", code: "code-1", choice: "full", selected_services: ["Company Formation", "Registered Agent"],
    }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(lastUpdatePatch).toMatchObject({ selected_services: ["Company Formation", "Registered Agent"] })
  })

  it("split: writes the same selection the plan was computed from", async () => {
    offerFixture = baseOffer()
    const res = await POST(makeRequest({
      token: "t1", code: "code-1", choice: "split", selected_services: ["Company Formation"],
    }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(lastUpdatePatch).toMatchObject({ selected_services: ["Company Formation"] })
    expect(lastUpdatePatch?.payment_plan).toBeTruthy()
  })
})

describe("choose-payment-split — 'full' clears any stale payment_plan (bug 2)", () => {
  beforeEach(() => {
    lastUpdatePatch = null
    updateResult = { data: [{ token: "t1" }], error: null }
  })

  it("explicitly nulls payment_plan even when one was already on the row", async () => {
    offerFixture = baseOffer({
      payment_plan: [{ seq: 1, amount: 1000, currency: "USD", trigger: { kind: "signing" } }],
    })
    const res = await POST(makeRequest({ token: "t1", code: "code-1", choice: "full" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(lastUpdatePatch).toMatchObject({ payment_plan: null })
  })

  it("split still writes the newly computed plan (unaffected by the full-branch fix)", async () => {
    offerFixture = baseOffer()
    const res = await POST(makeRequest({ token: "t1", code: "code-1", choice: "split" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(Array.isArray(lastUpdatePatch?.payment_plan)).toBe(true)
  })
})

describe("choose-payment-split — refuses an unresolved multi-option offer (bug 3)", () => {
  beforeEach(() => {
    lastUpdatePatch = null
  })

  it("refuses when packages exist and none is locked yet", async () => {
    offerFixture = baseOffer({
      packages: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      package_locked_at: null,
    })
    const res = await POST(makeRequest({ token: "t1", code: "code-1", choice: "full" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/multiple options/i)
    expect(lastUpdatePatch).toBeNull()
  })

  it("proceeds normally once a package is locked", async () => {
    offerFixture = baseOffer({
      packages: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      package_locked_at: "2026-08-27T00:00:00Z",
    })
    const res = await POST(makeRequest({ token: "t1", code: "code-1", choice: "full" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
  })

  it("an ordinary single-price offer (no packages at all) is unaffected", async () => {
    offerFixture = baseOffer()
    const res = await POST(makeRequest({ token: "t1", code: "code-1", choice: "full" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
  })
})
