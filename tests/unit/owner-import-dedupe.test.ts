/**
 * Same-money duplicate detection for the owner-books import.
 *
 * WHY THIS EXISTS: the books have one identity — transaction_ref — produced by three
 * unrelated generators. The bank-feed sweep writes `feed:<uuid>`; the CSV parsers
 * write a bank reference or a content hash over their own field set; the PDF/AI path
 * hashes a different field set again. Those namespaces can never collide, so the
 * ref-only dedup could not tell that the feed's copy and the statement's copy of the
 * same payment were the same payment — it booked both, silently, under a green
 * "imported successfully".
 *
 * The hard part is NOT catching duplicates. It is catching them WITHOUT dropping real
 * transactions: two separate $971 Stripe payouts on the same day are ordinary, and a
 * silently missing transaction is worse than a visible duplicate. Hence multiset
 * counting, and hence these tests lean on the "must NOT drop" cases.
 */
import { describe, it, expect } from "vitest"
import { partitionAgainstExisting, type OwnerImportRow, type ExistingBooksRow } from "@/lib/owner-transactions-import"

const row = (o: Partial<OwnerImportRow> = {}): OwnerImportRow => ({
  transaction_date: "2025-03-04",
  description: "STRIPE - TRANSFER",
  amount: 971,
  currency: "USD",
  bank_name: "Relay",
  transaction_ref: "h-abc",
  tax_year: 2025,
  ...o,
})

const existing = (o: Partial<ExistingBooksRow> = {}): ExistingBooksRow => ({
  transaction_date: "2025-03-04",
  amount: 971,
  bank_name: "Relay",
  currency: "USD",
  transaction_ref: "feed:uuid-1",
  ...o,
})

describe("catches the same money under a different label", () => {
  it("skips a statement row already booked by the bank feed", () => {
    const r = partitionAgainstExisting([row()], [existing()])
    expect(r.toInsert).toHaveLength(0)
    expect(r.skippedAlreadyBooked).toBe(1)
    expect(r.skippedSameSource).toBe(0)
    expect(r.duplicateSamples[0]).toContain("2025-03-04")
  })

  it("skips the same statement re-uploaded in a different format (different hash)", () => {
    // PDF path hashed a different field set, so the ref differs — content still matches.
    const r = partitionAgainstExisting([row({ transaction_ref: "h-different" })], [existing({ transaction_ref: "h-abc" })])
    expect(r.toInsert).toHaveLength(0)
    expect(r.skippedAlreadyBooked).toBe(1)
  })

  it("reports an exact re-upload separately from a same-money match", () => {
    // Different meaning to the operator: "you already uploaded this file" vs
    // "this money is already in your books from somewhere else".
    const r = partitionAgainstExisting([row({ transaction_ref: "h-abc" })], [existing({ transaction_ref: "h-abc" })])
    expect(r.skippedSameSource).toBe(1)
    expect(r.skippedAlreadyBooked).toBe(0)
    expect(r.toInsert).toHaveLength(0)
  })
})

describe("does NOT drop real transactions", () => {
  it("keeps a genuine second identical payout when only one is already booked", () => {
    // Two real $971 payouts, one already in the books. Exactly one must be inserted.
    const r = partitionAgainstExisting(
      [row({ transaction_ref: "h-1" }), row({ transaction_ref: "h-2" })],
      [existing()]
    )
    expect(r.toInsert).toHaveLength(1)
    expect(r.skippedAlreadyBooked).toBe(1)
  })

  it("keeps both when nothing is booked yet", () => {
    const r = partitionAgainstExisting([row({ transaction_ref: "h-1" }), row({ transaction_ref: "h-2" })], [])
    expect(r.toInsert).toHaveLength(2)
    expect(r.skippedAlreadyBooked).toBe(0)
  })

  it("an exact-ref re-upload does not let its existing row also swallow a real twin", () => {
    // The subtle one. Existing: one feed row + one statement row (h-1). Incoming:
    // h-1 again (exact) plus a genuine third payout. The h-1 match must consume the
    // h-1 existing row, leaving only the feed row to absorb one — so the third
    // payout still inserts... and here both existing rows are consumed, so it does
    // NOT. Assert the arithmetic explicitly rather than by intuition:
    // 2 existing same-key rows, 3 incoming same-key rows => exactly 1 inserted.
    const r = partitionAgainstExisting(
      [row({ transaction_ref: "h-1" }), row({ transaction_ref: "h-2" }), row({ transaction_ref: "h-3" })],
      [existing({ transaction_ref: "h-1" }), existing({ transaction_ref: "feed:uuid-9" })]
    )
    expect(r.toInsert).toHaveLength(1)
    expect(r.skippedSameSource).toBe(1)
    expect(r.skippedAlreadyBooked).toBe(1)
  })

  it("keeps a different amount on the same day at the same bank", () => {
    const r = partitionAgainstExisting([row({ amount: 972, transaction_ref: "h-x" })], [existing()])
    expect(r.toInsert).toHaveLength(1)
  })

  it("keeps the same amount on a different day", () => {
    const r = partitionAgainstExisting([row({ transaction_date: "2025-03-05", transaction_ref: "h-x" })], [existing()])
    expect(r.toInsert).toHaveLength(1)
  })

  it("keeps the same amount at a different bank", () => {
    const r = partitionAgainstExisting([row({ bank_name: "Mercury", transaction_ref: "h-x" })], [existing()])
    expect(r.toInsert).toHaveLength(1)
  })

  it("keeps the same amount in a different currency", () => {
    // EUR 100 and USD 100 on the same day at the same bank are different money.
    const r = partitionAgainstExisting([row({ currency: "EUR", transaction_ref: "h-x" })], [existing({ currency: "USD" })])
    expect(r.toInsert).toHaveLength(1)
  })
})

describe("key normalisation", () => {
  it("treats 971 and 971.00 as the same amount", () => {
    const r = partitionAgainstExisting([row({ amount: 971.0, transaction_ref: "h-x" })], [existing({ amount: 971 })])
    expect(r.toInsert).toHaveLength(0)
  })

  it("treats 'Relay' and ' relay ' as the same bank", () => {
    const r = partitionAgainstExisting([row({ bank_name: " relay ", transaction_ref: "h-x" })], [existing({ bank_name: "Relay" })])
    expect(r.toInsert).toHaveLength(0)
  })

  it("treats a missing currency as USD on both sides", () => {
    const r = partitionAgainstExisting([row({ currency: undefined, transaction_ref: "h-x" })], [existing({ currency: null })])
    expect(r.toInsert).toHaveLength(0)
  })

  it("does not treat a null existing bank as matching a named bank", () => {
    const r = partitionAgainstExisting([row({ transaction_ref: "h-x" })], [existing({ bank_name: null })])
    expect(r.toInsert).toHaveLength(1)
  })
})

describe("reporting", () => {
  it("caps the samples so a huge overlap cannot flood the UI", () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ transaction_ref: `h-${i}` }))
    const booked = Array.from({ length: 20 }, (_, i) => existing({ transaction_ref: `feed:${i}` }))
    const r = partitionAgainstExisting(many, booked)
    expect(r.skippedAlreadyBooked).toBe(20)
    expect(r.duplicateSamples).toHaveLength(5)
  })
})
