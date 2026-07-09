/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { createPendingReferral, creditReferrerForLead, reconcilePendingReferral, type PendingReferralRow } from "@/lib/operations/referral"
import type { SupabaseClient } from "@supabase/supabase-js"

// Mock the invoice creator — guard-branch tests never reach it; the happy path
// (real credit note) is covered by the sandbox integration test.
vi.mock("@/lib/portal/td-invoice", () => ({
  createTDInvoice: vi.fn().mockResolvedValue({ paymentId: "pay-1", total: -10 }),
}))

function builder(result: unknown) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    neq: () => b,
    insert: () => b,
    update: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (res: (v: unknown) => void) => res(result),
  }
  return b
}

// Queue results in the order createPendingReferral queries:
// 1) contacts (referrer email)  2) referrals (dedup)  3) referrals (insert)
function supa(results: unknown[]) {
  let i = 0
  return {
    from: vi.fn(() => builder(results[i++] ?? { data: null, error: null })),
  } as unknown as SupabaseClient
}

const base = {
  referrerContactId: "ref-1",
  referredLeadId: "lead-1",
  referredName: "Referred Friend",
  referredEmail: "friend@example.com",
}

describe("createPendingReferral", () => {
  it("creates a pending referral on the happy path", async () => {
    const s = supa([
      { data: { email: "referrer@example.com" } }, // referrer (different email)
      { data: [] }, // dedup: none
      { data: { id: "r-123" } }, // insert
    ])
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: true, id: "r-123" })
  })

  it("blocks self-referral (referrer refers their own email)", async () => {
    const s = supa([{ data: { email: "FRIEND@example.com" } }]) // same as referredEmail (case-insensitive)
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: false, reason: "self_referral" })
  })

  it("blocks a duplicate referral for the same lead", async () => {
    const s = supa([
      { data: { email: "referrer@example.com" } },
      { data: [{ id: "existing" }] }, // dedup: already exists
    ])
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: false, reason: "duplicate" })
  })

  it("reports an error when the insert fails", async () => {
    const s = supa([
      { data: { email: "referrer@example.com" } },
      { data: [] },
      { data: null, error: { message: "boom" } },
    ])
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: false, reason: "error", detail: "boom" })
  })
})

describe("createPendingReferral — referrer variants", () => {
  it("returns missing_referrer when neither contact nor account is given", async () => {
    const s = supa([])
    const res = await createPendingReferral(
      { referredLeadId: "lead-1", referredName: "X", referredEmail: "x@y.com" },
      s,
    )
    expect(res).toEqual({ created: false, reason: "missing_referrer" })
  })

  it("creates an account-only referral (no self-referral email check)", async () => {
    // Account path skips the contacts email query: 1) dedup 2) insert.
    const s = supa([
      { data: [] }, // dedup: none
      { data: { id: "r-acc" } }, // insert
    ])
    const res = await createPendingReferral(
      { referrerAccountId: "acct-9", referredLeadId: "lead-1", referredName: "X", referredEmail: "x@y.com" },
      s,
    )
    expect(res).toEqual({ created: true, id: "r-acc" })
  })
})

describe("reconcilePendingReferral", () => {
  const row = (o: Partial<PendingReferralRow>): PendingReferralRow => ({
    id: "r", referrer_contact_id: null, referrer_account_id: null, status: "pending", ...o,
  })

  it("cancels all pending rows and creates nothing when cleared", () => {
    const existing = [row({ id: "a", referrer_contact_id: "c1" })]
    expect(reconcilePendingReferral(existing, null)).toEqual({ cancelIds: ["a"], createFor: null, updateAccountId: null })
  })

  it("keeps a matching pending row and creates nothing", () => {
    const existing = [row({ id: "a", referrer_contact_id: "c1", referrer_account_id: "acctX" })]
    expect(reconcilePendingReferral(existing, { contactId: "c1", accountId: "acctX" }))
      .toEqual({ cancelIds: [], createFor: null, updateAccountId: null })
  })

  it("syncs the credit account when the same contact's company changes", () => {
    const existing = [row({ id: "a", referrer_contact_id: "c1", referrer_account_id: "old" })]
    expect(reconcilePendingReferral(existing, { contactId: "c1", accountId: "new" }))
      .toEqual({ cancelIds: [], createFor: null, updateAccountId: { id: "a", accountId: "new" } })
  })

  it("cancels the old pending row and creates for the new referrer", () => {
    const existing = [row({ id: "a", referrer_contact_id: "c1" })]
    expect(reconcilePendingReferral(existing, { contactId: "c2", accountId: null }))
      .toEqual({ cancelIds: ["a"], createFor: { contactId: "c2", accountId: null }, updateAccountId: null })
  })

  it("never touches a converted/credited row", () => {
    const existing = [
      row({ id: "done", referrer_contact_id: "c1", status: "credited" }),
      row({ id: "p", referrer_contact_id: "c9", status: "pending" }),
    ]
    // Switching to c1: the credited row is NOT 'pending' so it's ignored; the
    // stale pending c9 is cancelled and a fresh c1 link is created.
    expect(reconcilePendingReferral(existing, { contactId: "c1", accountId: null }))
      .toEqual({ cancelIds: ["p"], createFor: { contactId: "c1", accountId: null }, updateAccountId: null })
  })

  it("matches an account-only pick only when the row has no contact", () => {
    const existing = [row({ id: "a", referrer_account_id: "acct1" })]
    expect(reconcilePendingReferral(existing, { contactId: null, accountId: "acct1" }))
      .toEqual({ cancelIds: [], createFor: null, updateAccountId: null })
  })
})

describe("creditReferrerForLead — guard branches", () => {
  const creditBase = {
    referredLeadId: "lead-1",
    referredContactId: "c-1",
    referredAccountId: "a-1",
    setupFeeTotal: 2500,
    currency: "EUR" as const,
  }

  it("does nothing when there is no pending client referral", async () => {
    const s = supa([{ data: null }]) // referrals select → none
    const res = await creditReferrerForLead(creditBase, s)
    expect(res).toEqual({ issued: false, reason: "no_pending_referral" })
  })

  it("converts but skips credit when setup fee is zero", async () => {
    const s = supa([
      { data: { id: "r-1", referrer_contact_id: "rc-1", referrer_account_id: null } }, // referral
      { data: null }, // convert update
    ])
    const res = await creditReferrerForLead({ ...creditBase, setupFeeTotal: 0 }, s)
    expect(res).toEqual({ issued: false, reason: "zero_setup_fee", referralId: "r-1" })
  })

  it("skips credit when the referrer has no resolvable account", async () => {
    const s = supa([
      { data: { id: "r-1", referrer_contact_id: "rc-1", referrer_account_id: null } }, // referral
      { data: null }, // convert update
      { data: null }, // account_contacts → none
    ])
    const res = await creditReferrerForLead(creditBase, s)
    expect(res).toEqual({ issued: false, reason: "no_referrer_account", referralId: "r-1" })
  })
})
