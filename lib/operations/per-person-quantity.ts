/**
 * Per-person service shortfall reporting.
 *
 * A per-person service (ITIN — see the `per_person` catalog tag) can only ever
 * exist ONCE for a given person. So an offer line billing more than one unit
 * always means units for OTHER people, and activation can only ever fulfil one
 * of them on the buyer's contact.
 *
 * This module is the single place that decides what to TELL staff about the
 * gap, kept pure so it can be tested directly — the logic lives here rather
 * than inline in activate-service because the inline version got it wrong in a
 * way tests would have caught immediately: it announced "Created 1 for the
 * buyer" BEFORE creation was attempted, so a case where the guards skipped
 * creation entirely still reported one delivered. Two ITINs billed, zero
 * created, and the summary claimed success.
 *
 * The rule this encodes: describe what ACTUALLY happened, never what was
 * intended, and stay silent only when nothing was actually under-delivered.
 */

export interface PerPersonShortfallInput {
  /** Service type, e.g. "ITIN". Used in the message. */
  pipeline: string
  /** Units the offer bills for this pipeline. */
  quantity: number
  /** Units actually created during this activation. */
  createdCount: number
  /**
   * True when the buyer already held a live instance before this activation, so
   * NOTHING could be created for them. This is the case that used to pass
   * silently at quantity 1 ("client already has an ITIN, buys one for their
   * spouse") — a paid service never delivered, reported as clean success.
   */
  buyerAlreadyHasOne: boolean
}

/**
 * Returns a staff-facing warning describing the unfulfilled units, or null when
 * there is nothing to report (everything billed was delivered).
 */
export function describePerPersonShortfall(input: PerPersonShortfallInput): string | null {
  const { pipeline, quantity, createdCount, buyerAlreadyHasOne } = input

  // Defensive: a non-positive or nonsensical quantity has nothing to report.
  if (!Number.isFinite(quantity) || quantity < 1) return null

  if (buyerAlreadyHasOne) {
    // Nothing was created — every billed unit is for someone else.
    const units = quantity === 1 ? "unit" : "units"
    const belong =
      quantity === 1
        ? "the billed unit belongs to another person"
        : `all ${quantity} billed units belong to other people`
    return (
      `${pipeline}: the offer bills ${quantity} ${units}, but the buyer already has a ${pipeline} ` +
      `and one person can only ever hold one. NOTHING was created — ${belong} and must be created ` +
      `on their own contact.`
    )
  }

  const shortfall = quantity - createdCount
  if (shortfall <= 0) return null

  if (createdCount === 0) {
    // Billed, nothing created, and not because the buyer already had one —
    // something else failed. Say exactly that rather than guessing why.
    return (
      `${pipeline}: the offer bills ${quantity} unit${quantity === 1 ? "" : "s"} but NONE were created. ` +
      `Check the service-delivery errors for this activation and create them manually.`
    )
  }

  return (
    `${pipeline}: the offer bills ${quantity} units and one person can only ever hold one. ` +
    `Created ${createdCount} for the buyer — the other ${shortfall} belong to different people ` +
    `and must each be created on their own contact.`
  )
}
