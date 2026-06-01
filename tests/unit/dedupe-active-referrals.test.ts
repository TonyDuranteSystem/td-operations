import { describe, it, expect } from "vitest"
import { dedupeActiveReferrals, type DedupeReferralInput } from "@/lib/referral-utils"

// Minimal row factory — only the fields dedupe cares about.
function row(p: Partial<DedupeReferralInput> & { id: string }): DedupeReferralInput {
  return {
    id: p.id,
    referrer_contact_id: p.referrer_contact_id ?? null,
    referrer_account_id: p.referrer_account_id ?? null,
    referred_contact_id: p.referred_contact_id ?? null,
    referred_account_id: p.referred_account_id ?? null,
    referred_name: p.referred_name ?? null,
    status: p.status ?? "pending",
    created_at: p.created_at ?? "2026-01-01T00:00:00Z",
  }
}

describe("dedupeActiveReferrals", () => {
  it("returns distinct referrals unchanged, preserving order", () => {
    const rows = [
      row({ id: "a", referrer_contact_id: "R1", referred_contact_id: "X" }),
      row({ id: "b", referrer_contact_id: "R1", referred_contact_id: "Y" }),
      row({ id: "c", referrer_contact_id: "R2", referred_contact_id: "Z" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("collapses a duplicate pair (same referrer → same referred) to ONE row", () => {
    // The real prod bug: Apr-2 pending + later converted for the same pair.
    const rows = [
      row({ id: "conv", referrer_contact_id: "IVAN", referred_contact_id: "PATRICK", status: "converted", created_at: "2026-05-29T00:00:00Z" }),
      row({ id: "pend", referrer_contact_id: "IVAN", referred_contact_id: "PATRICK", status: "pending", created_at: "2026-04-02T00:00:00Z" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("conv") // most-progressed wins
  })

  it("keeps the most-progressed status regardless of input order", () => {
    const rows = [
      row({ id: "pend", referrer_contact_id: "R", referred_contact_id: "X", status: "pending" }),
      row({ id: "conv", referrer_contact_id: "R", referred_contact_id: "X", status: "converted" }),
      row({ id: "paid", referrer_contact_id: "R", referred_contact_id: "X", status: "paid" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("paid")
  })

  it("drops cancelled rows entirely", () => {
    const rows = [
      row({ id: "a", referrer_contact_id: "R1", referred_contact_id: "X", status: "cancelled" }),
      row({ id: "b", referrer_contact_id: "R2", referred_contact_id: "Y", status: "converted" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out.map((r) => r.id)).toEqual(["b"])
  })

  it("keeps two DIFFERENT referred people for the same referrer (a real 2-referral case)", () => {
    const rows = [
      row({ id: "a", referrer_contact_id: "R", referred_contact_id: "X" }),
      row({ id: "b", referrer_contact_id: "R", referred_contact_id: "Y" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out).toHaveLength(2)
  })

  it("dedupes on account-based referrer key when contact id is absent", () => {
    const rows = [
      row({ id: "a", referrer_account_id: "ACC", referred_contact_id: "X", status: "pending" }),
      row({ id: "b", referrer_account_id: "ACC", referred_contact_id: "X", status: "converted" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("b")
  })

  it("falls back to referred_name when no referred id is present", () => {
    const rows = [
      row({ id: "a", referrer_contact_id: "R", referred_name: "Mario Rossi", status: "pending" }),
      row({ id: "b", referrer_contact_id: "R", referred_name: "Mario Rossi", status: "converted" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("b")
  })

  it("treats rows missing a referrer or referred identity as unique (keyed by id)", () => {
    const rows = [
      row({ id: "a", referred_contact_id: "X" }), // no referrer key
      row({ id: "b", referred_contact_id: "X" }), // no referrer key — must NOT merge with a
      row({ id: "c", referrer_contact_id: "R" }), // no referred key
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"])
  })

  it("handles an empty list", () => {
    expect(dedupeActiveReferrals([])).toEqual([])
  })

  it("preserves all original fields on the winning row", () => {
    const rows = [
      row({ id: "win", referrer_contact_id: "R", referred_contact_id: "X", status: "converted", created_at: "2026-05-01T00:00:00Z" }),
    ]
    const out = dedupeActiveReferrals(rows)
    expect(out[0]).toEqual(rows[0])
  })
})
