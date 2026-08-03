/**
 * Temporary portal passwords — the ONE place they are minted.
 *
 * WHY THIS EXISTS (2026-08-03): fourteen sites each hand-rolled
 * `TD${Math.random().toString(36).slice(2, 10)}!` (and one variant,
 * `TDp${...slice(2, 8)}!`, only SIX characters). `Math.random()` is V8's
 * xorshift128+ — built to be fast and evenly distributed, NOT unpredictable.
 * It is an unseeded formula with internal state: observe a handful of outputs
 * from the same warm serverless instance and the state can be recovered, and
 * with it the other values from that stream. Our own clients legitimately
 * receive these passwords, so samples are not hard to come by.
 *
 * What made it worth fixing rather than noting: `must_change_password` is a
 * CLIENT-SIDE nag (a redirect in the portal layout), not enforced by middleware
 * on any API route — so an emailed temp password stays a WORKING credential to
 * that client's tax returns, EIN/ITIN and invoices indefinitely, whether or not
 * they ever change it.
 *
 * Design choices, deliberate:
 *  - `crypto.randomInt` per character: cryptographically secure AND unbiased
 *    for ANY alphabet size. The security win over the old code is the SOURCE of
 *    randomness (a CSPRNG instead of xorshift128+), not bias — see the next
 *    point, which is what actually governs bias here.
 *  - The alphabet is exactly 32 symbols, deliberately a POWER OF TWO. That
 *    means 256 divides evenly by it, so even a naive `randomBytes(1)[0] % 32`
 *    would be unbiased today. Do NOT read that as licence to switch to modulo:
 *    add or remove a single character and 33 or 31 silently skews the draw
 *    toward the earliest symbols. `randomInt` is correct regardless, and a unit
 *    test pins the size at 32 so the property is not lost by accident.
 *  - The alphabet EXCLUDES the confusable pairs 0/o and 1/l. A client types
 *    this by hand out of an email; "was that a one or an ell?" is a support
 *    ticket, and the two characters buy almost no entropy.
 *  - 12 characters over a 34-symbol alphabet ≈ 2.4e18 combinations, versus
 *    ~2.8e12 for the old 8 lowercase-alphanumerics — and unpredictable rather
 *    than merely large.
 *  - The `TD…!` shape is KEPT on purpose. Clients and staff recognise it, and
 *    it satisfies the portal's 8-character minimum without depending on the
 *    random part for length.
 */
import { randomInt } from "node:crypto"

/** Lowercase alphanumerics minus the confusable pairs 0/o and 1/l. */
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz"

/** Characters of randomness in the middle section. */
const LENGTH = 12

/**
 * Mint a temporary portal password.
 *
 * ALWAYS use this — never hand-roll one, and never reach for `Math.random()`
 * for anything a person can log in with.
 */
export function generateTempPassword(): string {
  let middle = ""
  for (let i = 0; i < LENGTH; i++) {
    middle += ALPHABET[randomInt(ALPHABET.length)]
  }
  return `TD${middle}!`
}

/** Exported for the tests that pin the shape and the alphabet. */
export const TEMP_PASSWORD_ALPHABET = ALPHABET
export const TEMP_PASSWORD_RANDOM_LENGTH = LENGTH
