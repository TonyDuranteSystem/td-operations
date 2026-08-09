/**
 * Payer-learning rules — what may be remembered, and how a payer is keyed.
 *
 * Dev jobs `ae8b8bb1` / `c0a61e44`. Every fixture below is a REAL descriptor from the
 * production bank feed, because the whole point of this module is surviving how banks actually
 * write things. The negative cells are the important ones: the processor list is the only guard
 * that fires automatically once per-client confirmation replaced the multi-client block.
 */
import { describe, it, expect } from "vitest"
import {
  PAYER_FILLER_TOKENS,
  buildTaughtPayerIndex,
  taughtClientsFor,
  evaluateTeachEligibility,
  isProcessorOnlyDescriptor,
  normalisePayerText,
  payerTokens,
  processorsNamed,
  resolvePayerKey,
} from "@/lib/finance/payer-learning-rules"

describe("isProcessorOnlyDescriptor — the one automatic guard", () => {
  it("refuses a bare payment rail", () => {
    // Measured on confirmed client money: "Wise" sits behind 33 different clients and
    // "Mercury" behind 49. Teaching one of these would hand that client everyone else's money.
    expect(isProcessorOnlyDescriptor("WISE US INC")).toBe(true)
    expect(isProcessorOnlyDescriptor("The Currency Cloud Limited")).toBe(true)
    expect(isProcessorOnlyDescriptor("STRIPE - TRANSFER")).toBe(true)
    expect(isProcessorOnlyDescriptor("Mercury")).toBe(true)
    expect(isProcessorOnlyDescriptor("Revolut")).toBe(true)
  })

  it("allows a descriptor that carries the client's own text through a rail", () => {
    expect(isProcessorOnlyDescriptor("Currency Cloud - Oh My Crea")).toBe(false)
    expect(isProcessorOnlyDescriptor("NIUM . N.Marketing LLC via your multi")).toBe(false)
    expect(isProcessorOnlyDescriptor("TRAINADZ US LLC - From TrainAdz US LLC via mercury.com")).toBe(false)
    expect(isProcessorOnlyDescriptor("Wise Inc; Services; TONY DURANTE L.L.C.; From Relation Box LLC Via WISE")).toBe(false)
    expect(isProcessorOnlyDescriptor("Domenico Pio Cristiano")).toBe(false)
    expect(isProcessorOnlyDescriptor("XECOM CONSULTING; ACH Pmt; Merchant name: XECOM CONSULTING")).toBe(false)
  })

  it("⛔ ALLOWS the payer the NAME rule cannot see — the case learning exists for", () => {
    // "WM International LLC" has ZERO significant words under the name-coverage rule ("wm" is
    // below the length floor; "international" and "llc" are stop words there). If this test
    // reused that stop-word list, this descriptor would reduce to nothing and be refused as
    // processor-only — blocking precisely the payer that only a human can identify.
    expect(isProcessorOnlyDescriptor("WM International - From WM International LLC via mercury.com")).toBe(false)
    // Proof the two lists really differ: these are stop words for NAME matching but content here.
    expect(PAYER_FILLER_TOKENS.has("international")).toBe(false)
    expect(PAYER_FILLER_TOKENS.has("consulting")).toBe(false)
  })

  it("treats a descriptor of pure filler as unteachable too — it identifies nobody", () => {
    expect(isProcessorOnlyDescriptor("From LLC via")).toBe(true)
    expect(isProcessorOnlyDescriptor("")).toBe(true)
    expect(isProcessorOnlyDescriptor(null)).toBe(true)
  })

  it("names the processors it found, so a refusal can explain itself", () => {
    expect(processorsNamed("WISE US INC")).toEqual(["wise"])
    expect(processorsNamed("The Currency Cloud Limited").sort()).toEqual(["cloud", "currency"])
    expect(processorsNamed("Domenico Pio Cristiano")).toEqual([])
  })
})

describe("normalisation and tokens", () => {
  it("collapses punctuation and case so bank formatting does not create two payers", () => {
    expect(normalisePayerText("  WM International -  From   WM International LLC  ")).toBe(
      "wm international from wm international llc",
    )
    expect(normalisePayerText("Domenico Pio Cristiano")).toBe("domenico pio cristiano")
  })

  it("drops pure numbers — a per-transaction reference must not become part of the identity", () => {
    // Airwallex references differ on every transaction (…220F28_1 vs …191NN1_1), so a key that
    // absorbed them would never match twice.
    expect(payerTokens("Relay Financial US Corp - May 2026 Partner Payout")).not.toContain("2026")
  })

  it("keeps short but distinctive tokens like initials", () => {
    expect(payerTokens("WM International")).toContain("wm")
  })
})

describe("resolvePayerKey — the strongest identity available", () => {
  it("prefers a structured counterparty id when the source supplies one", () => {
    const key = resolvePayerKey({
      source: "mercury_api",
      sender_name: "Mercury",
      raw_data: { counterpartyId: "cp_12345" },
    })
    expect(key).toEqual({ key_type: "counterparty_id", key_value: "cp_12345", display_payer: "Mercury" })
  })

  it("falls back to the normalised descriptor, keeping the bank's wording for display", () => {
    const key = resolvePayerKey({ source: "airwallex_api", sender_name: "Domenico Pio Cristiano" })
    expect(key?.key_type).toBe("descriptor")
    expect(key?.key_value).toBe("domenico pio cristiano")
    expect(key?.display_payer).toBe("Domenico Pio Cristiano")
  })

  it("⛔ NEVER keys on the memo or the reference", () => {
    // Mercury's referral bonuses put "Cash bonus for referring <CLIENT> LLC" in BOTH the memo
    // and the reference. Keying on either would remember TD's own bonus as that client's payer.
    const key = resolvePayerKey({
      source: "mercury_api",
      sender_name: null,
      raw_data: { memo: "Cash bonus for referring ATCOACHING LLC.", sender_reference: "Cash bonus for referring ATCOACHING LLC." },
    })
    expect(key).toBeNull()
  })

  it("returns nothing when the bank gave no payer at all", () => {
    expect(resolvePayerKey({ source: "relay", sender_name: "   " })).toBeNull()
  })
})

describe("evaluateTeachEligibility — explained refusals, never silent ones", () => {
  it("allows a real client payer", () => {
    const res = evaluateTeachEligibility({ source: "airwallex_api", sender_name: "Domenico Pio Cristiano", status: "unmatched" })
    expect(res.ok).toBe(true)
    expect(res.key?.key_value).toBe("domenico pio cristiano")
  })

  it("refuses money leaving the account", () => {
    const res = evaluateTeachEligibility({ source: "relay", sender_name: "James - 2024 Tax Returns", status: "outgoing" })
    expect(res.ok).toBe(false)
    expect(res.refusal).toBe("money_leaving")
  })

  it("refuses a bare rail and says why, naming the rail", () => {
    const res = evaluateTeachEligibility({ source: "mercury", sender_name: "WISE US INC", status: "unmatched" })
    expect(res.ok).toBe(false)
    expect(res.refusal).toBe("processor_only")
    expect(res.detail).toContain("wise")
    expect(res.detail).toContain("misattribute")
  })

  it("does NOT apply the processor test to a structured id — a counterparty id is one sender", () => {
    // "Mercury" as a NAME is a rail; a Mercury counterparty ID is a specific counterparty.
    const res = evaluateTeachEligibility({
      source: "mercury_api",
      sender_name: "Mercury",
      raw_data: { counterpartyId: "cp_999" },
      status: "unmatched",
    })
    expect(res.ok).toBe(true)
    expect(res.key?.key_type).toBe("counterparty_id")
  })

  it("refuses when there is no payer identity to remember", () => {
    const res = evaluateTeachEligibility({ source: "relay", sender_name: null, status: "unmatched" })
    expect(res.ok).toBe(false)
    expect(res.refusal).toBe("no_payer_identity")
  })
})

describe("taughtClientsFor — the in-memory lookup [UNIT]", () => {
  const AIRWALLEX = { id: "f1", source: "airwallex_api", sender_name: "Domenico Pio Cristiano", status: "unmatched" }
  const mapping = {
    id: "m1", source: "airwallex_api", key_type: "descriptor" as const,
    key_value: "domenico pio cristiano", account_id: null, contact_id: "c-1",
  }

  it("finds a taught payer", () => {
    const index = buildTaughtPayerIndex([mapping])
    expect(taughtClientsFor(AIRWALLEX, index).mappings).toHaveLength(1)
  })

  it("is scoped per SOURCE — the same wording at another bank is a different payer", () => {
    const index = buildTaughtPayerIndex([mapping])
    expect(taughtClientsFor({ ...AIRWALLEX, source: "relay" }, index).mappings).toHaveLength(0)
  })

  it("returns every client taught for one payer, not just the first", () => {
    // Real shape: one descriptor legitimately pays two companies with different owners.
    const index = buildTaughtPayerIndex([mapping, { ...mapping, id: "m2", contact_id: "c-2" }])
    expect(taughtClientsFor(AIRWALLEX, index).mappings).toHaveLength(2)
  })

  it("never answers for money leaving the account", () => {
    const index = buildTaughtPayerIndex([mapping])
    expect(taughtClientsFor({ ...AIRWALLEX, status: "outgoing" }, index).mappings).toHaveLength(0)
  })

  it("⛔ IGNORES a live mapping whose payer is now a known rail, and says so", () => {
    // The mapping was taught before that rail was listed. The teach-time guard cannot help
    // retrospectively, which is exactly why the guard runs again here.
    const railFeed = { id: "f2", source: "mercury", sender_name: "WISE US INC", status: "unmatched" }
    const index = buildTaughtPayerIndex([
      { ...mapping, id: "m3", source: "mercury", key_value: "wise us inc" },
    ])
    const res = taughtClientsFor(railFeed, index)
    expect(res.mappings).toHaveLength(0)
    expect(res.suppressedAsProcessor).toBe(true)
  })

  it("an empty index is silent rather than throwing", () => {
    expect(taughtClientsFor(AIRWALLEX, buildTaughtPayerIndex([])).mappings).toHaveLength(0)
  })
})
