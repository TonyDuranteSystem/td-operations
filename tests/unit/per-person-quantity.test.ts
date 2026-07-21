/**
 * Unit tests for describePerPersonShortfall (lib/operations/per-person-quantity.ts).
 *
 * This logic runs AFTER a client's payment is confirmed, so every case here is
 * a money case: an unreported shortfall is a paid service that is never
 * delivered and never flagged. Two real defects motivated these tests — the
 * message claiming "Created 1 for the buyer" when zero were created, and the
 * quantity-1 case reporting clean success when nothing was delivered.
 */

import { describe, it, expect } from "vitest"
import { describePerPersonShortfall } from "@/lib/operations/per-person-quantity"

describe("describePerPersonShortfall", () => {
  it("says nothing when everything billed was delivered", () => {
    expect(
      describePerPersonShortfall({
        pipeline: "ITIN",
        quantity: 1,
        createdCount: 1,
        buyerAlreadyHasOne: false,
      }),
    ).toBeNull()
  })

  // Regression: the message used to be built BEFORE creation was attempted, so
  // a skipped creation still reported one delivered.
  it("never claims a creation that did not happen", () => {
    const msg = describePerPersonShortfall({
      pipeline: "ITIN",
      quantity: 2,
      createdCount: 0,
      buyerAlreadyHasOne: true,
    })
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/NOTHING was created/i)
    expect(msg).not.toMatch(/Created 1/i)
  })

  // Regression: "buyer already has an ITIN, buys one for their spouse" produced
  // no warning at all and the activation reported clean success.
  it("warns at quantity 1 when the buyer already holds the service", () => {
    const msg = describePerPersonShortfall({
      pipeline: "ITIN",
      quantity: 1,
      createdCount: 0,
      buyerAlreadyHasOne: true,
    })
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/already has a ITIN/i)
    expect(msg).toMatch(/NOTHING was created/i)
    expect(msg).toMatch(/another person/i)
  })

  it("reports the real shortfall when some units were created", () => {
    const msg = describePerPersonShortfall({
      pipeline: "ITIN",
      quantity: 3,
      createdCount: 1,
      buyerAlreadyHasOne: false,
    })
    expect(msg).toMatch(/bills 3 units/i)
    expect(msg).toMatch(/Created 1 for the buyer/i)
    expect(msg).toMatch(/the other 2/i)
  })

  it("distinguishes 'nothing created for another reason' from 'buyer already has one'", () => {
    const msg = describePerPersonShortfall({
      pipeline: "ITIN",
      quantity: 2,
      createdCount: 0,
      buyerAlreadyHasOne: false,
    })
    expect(msg).toMatch(/NONE were created/i)
    expect(msg).toMatch(/create them manually/i)
    // must NOT blame the buyer already having one — that was not the cause
    expect(msg).not.toMatch(/already has/i)
  })

  it("uses singular/plural correctly", () => {
    const one = describePerPersonShortfall({
      pipeline: "ITIN",
      quantity: 1,
      createdCount: 0,
      buyerAlreadyHasOne: true,
    })
    const many = describePerPersonShortfall({
      pipeline: "ITIN",
      quantity: 4,
      createdCount: 0,
      buyerAlreadyHasOne: true,
    })
    expect(one).toMatch(/1 unit,/)
    expect(one).toMatch(/the billed unit belongs to another person/i)
    expect(many).toMatch(/4 units,/)
    expect(many).toMatch(/all 4 billed units belong to other people/i)
  })

  it("names the pipeline so a future per-person service reads correctly", () => {
    const msg = describePerPersonShortfall({
      pipeline: "ITIN Renewal",
      quantity: 2,
      createdCount: 1,
      buyerAlreadyHasOne: false,
    })
    expect(msg).toMatch(/^ITIN Renewal:/)
  })

  it("stays silent on nonsensical quantities instead of emitting a broken message", () => {
    for (const quantity of [0, -1, Number.NaN]) {
      expect(
        describePerPersonShortfall({
          pipeline: "ITIN",
          quantity,
          createdCount: 0,
          buyerAlreadyHasOne: true,
        }),
      ).toBeNull()
    }
  })

  it("does not warn when created exceeds billed (never under-delivered)", () => {
    expect(
      describePerPersonShortfall({
        pipeline: "ITIN",
        quantity: 1,
        createdCount: 2,
        buyerAlreadyHasOne: false,
      }),
    ).toBeNull()
  })
})
