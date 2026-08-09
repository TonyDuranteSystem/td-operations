/**
 * Client-payer evidence — the router gap that filed a live client's wire as the owner's money.
 *
 * Origin: dev job `ae8b8bb1` (2026-08-09). A client wired half of his signed offer. The wire
 * carried his name and nothing else, and half is 50% away from the invoice total, so every
 * evidence test the router had failed and the payment was filed as the owner's own money —
 * invisible to the matching queue, with no alert. It sat for two days.
 *
 * The two cells that matter most here are the NEGATIVE ones:
 *  - the owner's own entity must never count as a client (its name is printed on TD's own
 *    payout descriptors, so getting this wrong drags every Stripe payout back into Finance);
 *  - a partial name match must never route money (a surname identifies nobody) — it may only
 *    raise a hint for a person.
 */
import { describe, it, expect } from "vitest"
import {
  EXPECTED_PAYMENT_TOLERANCE_PCT,
  MIN_ROSTER_NAME_WORDS,
  MIN_WEAK_MATCHED_WORDS,
  couldBePartPayment,
  isOwnEntityRosterEntry,
  matchPayerToRoster,
  matchesExpectedPayment,
  type ClientRosterEntry,
} from "@/lib/finance/client-payer-evidence"
import { TD_ENTITY_ID } from "@/lib/owner-finance"

const CLIENT: ClientRosterEntry = { id: "c-1", name: "Domenico Cristiano", kind: "contact" }
/**
 * TWO significant words on purpose. "Vandenberg Holdings LLC" would NOT work here: both
 * "holdings" and "llc" are stop words, leaving one significant word, which one token covers
 * 100% — the documented single-word residual. Picking that name by accident is how a test
 * quietly asserts the opposite of what it claims.
 */
const COMPANY: ClientRosterEntry = { id: "a-1", name: "Vandenberg Logistics", kind: "account" }
/** The owner's own books entity — really is a row in `accounts`, really is named after TD. */
const OWN_ENTITY: ClientRosterEntry = { id: TD_ENTITY_ID, name: "Tony Durante LLC", kind: "account" }

describe("matchPayerToRoster — whose money is this", () => {
  it("recognises the payer even when the bank adds a middle name", () => {
    // The real wire read "Domenico Pio Cristiano"; "pio" is below the significant-word length,
    // so both of the client's own words are still covered.
    const res = matchPayerToRoster(["Domenico Pio Cristiano", null, "010F345262220F28_1"], [CLIENT])
    expect(res.named?.entry.id).toBe("c-1")
    expect(res.named?.evidence.coverage).toBe(1)
  })

  it("REFUSES to treat the owner's own entity as a client, even on a perfect name match", () => {
    // ⛔ THE REGRESSION GUARD. Every Mercury Stripe payout descriptor names TD itself. If the
    // owner entity were matched by name, 43 payouts (~$57k) would be swept back into Finance —
    // exactly the noise the owner-ledger split removed.
    const payout = ["STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE", null, null]
    expect(matchPayerToRoster(payout, [OWN_ENTITY]).named).toBeNull()
    expect(matchPayerToRoster(payout, [OWN_ENTITY]).weak).toBeNull()
    expect(isOwnEntityRosterEntry(OWN_ENTITY)).toBe(true)
  })

  it("never routes a partial name match, and does not even hint on ONE matched word", () => {
    // Only one of two significant words matched: 50% < the 60% bar, so never routable — that is
    // the shape of the 2026-07-29 wrong-client incident. And it is not reported as a hint either:
    // replaying the real book showed single-word hints firing on 27 of 64 correctly-filed rows.
    const res = matchPayerToRoster(["Vandenberg", null, null], [COMPANY])
    expect(res.named).toBeNull()
    expect(res.weak).toBeNull()
  })

  it("hints only once at least two of the client's words are present", () => {
    // FOUR significant words, TWO matched = 50%: below the 60% routing bar (so never routable),
    // but two words is no longer a coincidence, so a person is told. Note two-of-three would be
    // 67% and would ROUTE — the two thresholds interact, which is why this fixture is spelled out.
    const fourWord: ClientRosterEntry = { id: "a-5", name: "Vandenberg Freight Rotterdam Antwerp", kind: "account" }
    const res = matchPayerToRoster(["VANDENBERG FREIGHT"], [fourWord])
    expect(res.named).toBeNull()
    expect(res.weak?.entry.id).toBe("a-5")
    expect(MIN_WEAK_MATCHED_WORDS).toBe(2)
  })

  it("does not match a bank or processor name against the roster", () => {
    const roster = [CLIENT, COMPANY]
    expect(matchPayerToRoster(["Relay Financial US Corp - May 2026 Partner Payout Program"], roster).named).toBeNull()
    expect(matchPayerToRoster(["The Currency Cloud Limited"], roster).named).toBeNull()
    expect(matchPayerToRoster(["Mercury"], roster).named).toBeNull()
  })

  it("ignores roster entries that carry no significant words", () => {
    const noise: ClientRosterEntry = { id: "a-2", name: "LLC", kind: "account" }
    expect(matchPayerToRoster(["some wire"], [noise]).named).toBeNull()
  })

  it("prefers the strongest match when two clients could fit", () => {
    const partial: ClientRosterEntry = { id: "a-3", name: "Vandenberg Freight", kind: "account" }
    const res = matchPayerToRoster(["Vandenberg Logistics"], [partial, COMPANY])
    expect(res.named?.entry.id).toBe("a-1")
  })

  it("⛔ REFUSES to identify a payer from a ONE-WORD client name", () => {
    // I originally asserted the opposite here and called it accepted, quoting the shared rule's
    // own note. Cell 0 proved that wrong WITH MONEY: a client called "LT Program LLC" reduces to
    // the single word "program", every Relay partner payout descriptor ends "Partner Payout
    // Program", and the router therefore kept TD's OWN payout in Finance as that client's
    // payment. One word is the whole decision here and there is no backstop, unlike the matcher.
    // Such clients are still recognised — by being TAUGHT, which is what learning is for.
    const oneWord: ClientRosterEntry = { id: "a-4", name: "Marka LLC", kind: "account" }
    expect(matchPayerToRoster(["MARKA - wire transfer"], [oneWord]).named).toBeNull()
    expect(MIN_ROSTER_NAME_WORDS).toBe(2)
  })

  it("the real regression: a partner payout is not claimed by a one-word client name", () => {
    const ltProgram: ClientRosterEntry = { id: "a-6", name: "LT Program LLC", kind: "account" }
    expect(
      matchPayerToRoster(["Relay Financial US Corp - May 2026 Partner Payout Program"], [ltProgram]).named,
    ).toBeNull()
  })

  it("returns nothing for an empty roster rather than throwing", () => {
    expect(matchPayerToRoster(["anyone"], []).named).toBeNull()
  })
})

describe("matchesExpectedPayment — the amount a client was told to send", () => {
  const expected = [{ amount: 1250, currency: "EUR", label: "instalment 1 of 2" }]

  it("matches the quoted instalment exactly", () => {
    expect(matchesExpectedPayment(1250, "EUR", expected)?.label).toBe("instalment 1 of 2")
  })

  it("absorbs a wire fee shaved off in transit", () => {
    // 2% of €1,250 = €25.
    expect(matchesExpectedPayment(1235, "EUR", expected)).not.toBeNull()
    expect(matchesExpectedPayment(1200, "EUR", expected)).toBeNull()
  })

  it("REFUSES a different currency — the same number is not the same money", () => {
    expect(matchesExpectedPayment(1250, "USD", expected)).toBeNull()
  })

  it("never matches on a zero or negative amount", () => {
    expect(matchesExpectedPayment(0, "EUR", expected)).toBeNull()
    expect(matchesExpectedPayment(Number.NaN, "EUR", expected)).toBeNull()
  })

  it("stays well clear of the next instalment of a realistic plan", () => {
    // Two €1,250 instalments and a €2,500 total: the tolerance must not let one stand for both.
    const plan = [{ amount: 1250, currency: "EUR" }]
    expect(matchesExpectedPayment(2500, "EUR", plan)).toBeNull()
  })

  it("keeps its tolerance a knob tests can pin, not a hidden constant", () => {
    expect(EXPECTED_PAYMENT_TOLERANCE_PCT).toBe(0.02)
    expect(matchesExpectedPayment(1000, "EUR", [{ amount: 1250, currency: "EUR" }], 0.5)).not.toBeNull()
  })
})

describe("couldBePartPayment — a hint, deliberately never a decision", () => {
  const owed = [{ amount: 2500, currency: "EUR" }]

  it("spots a half-payment of an open bill", () => {
    expect(couldBePartPayment(1250, "EUR", owed)).toBe(true)
  })

  it("ignores a rounding-error sliver", () => {
    expect(couldBePartPayment(12, "EUR", owed)).toBe(false)
  })

  it("ignores the full amount (the router's own band already covers it)", () => {
    expect(couldBePartPayment(2500, "EUR", owed)).toBe(false)
  })

  it("requires the same currency", () => {
    expect(couldBePartPayment(1250, "USD", owed)).toBe(false)
  })
})
