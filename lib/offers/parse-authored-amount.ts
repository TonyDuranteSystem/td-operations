/**
 * ⛔ PARSING A MONEY AMOUNT A HUMAN JUST TYPED — deliberately NOT `parsePriceQuirk`.
 *
 * `parsePriceQuirk` (lib/offers/compute-offer-totals.ts) strips everything except digits and
 * dots and then parseFloats, so "1.750" becomes **1.75**. That behaviour is PINNED ON PURPOSE
 * for STORED offer prices — changing it would re-price historical offers — and it must not be
 * reused for a field someone is typing into right now.
 *
 * It shipped into the payment-plan authoring field and the bug-hunter caught it before merge:
 * an Italian-formatted "1.750" silently became a €1.75 part on a €3,500 offer, and it was
 * invisible because the authoring echo renders only the wording, never the money.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────
 * Ambiguity is REPORTED, never guessed. `1.750` could be one-thousand-seven-hundred-fifty
 * (Italian) or one-point-seven-five (English), and this module cannot know which. A wrong
 * guess is a wrong invoice to a real client, so the caller is told it is ambiguous and the
 * author is asked to disambiguate — the same posture as the existing dot-thousands warning on
 * service prices (`ambiguousDotPrices`), which exists because TD staff really do type this.
 *
 * Grouped forms are NOT ambiguous and are accepted: "1.234.567" and "1,750" have only one
 * sensible reading.
 */

export type AuthoredAmount =
  /** Parsed cleanly. `amount` is a positive number. */
  | { kind: "ok"; amount: number }
  /** Nothing typed yet — not an error, just not ready. */
  | { kind: "empty" }
  /** Typed, but not a number at all. */
  | { kind: "invalid"; raw: string }
  /**
   * A single dot with exactly three digits after it and no other separator: "1.750".
   * Both readings are plausible; the caller must ask rather than pick.
   */
  | { kind: "ambiguous"; raw: string; asThousands: number; asDecimal: number }

/** Digits, separators and whitespace only — currency symbols and stray spaces are dropped. */
function strip(raw: string): string {
  return raw.replace(/[^\d.,]/g, "").trim()
}

export function parseAuthoredAmount(raw: unknown): AuthoredAmount {
  const original = String(raw ?? "").trim()
  const s = strip(original)
  // Something WAS typed but none of it was numeric ("abc") — that is wrong input, not an
  // empty field, and the caller must be able to tell those apart.
  if (!s) return original ? { kind: "invalid", raw: original } : { kind: "empty" }

  // Unambiguous groupings first. NOTE the {2,}: with `+` this matched the single-group
  // "1.750" and returned 1750, swallowing the ambiguous case below — caught by this module's
  // own tests before merge. TWO or more dot-groups can only be thousands separators.
  if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) return ok(Number(s.replace(/\./g, "")), s)
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return ok(Number(s.replace(/,/g, "")), s)
  // Continental decimal: "1.234,56" — dots group, comma decides the cents.
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s)) return ok(Number(s.replace(/\./g, "").replace(",", ".")), s)
  // Bare comma decimal: "1750,50"
  if (/^\d+,\d{1,2}$/.test(s)) return ok(Number(s.replace(",", ".")), s)

  // ⛔ THE AMBIGUOUS CASE. One dot, exactly three digits after it, nothing else: "1.750".
  if (/^\d{1,3}\.\d{3}$/.test(s)) {
    return {
      kind: "ambiguous",
      raw: s,
      asThousands: Number(s.replace(".", "")),
      asDecimal: Number(s),
    }
  }

  // Plain integer, or a decimal with 1-2 places ("1750", "1750.5", "1750.50", ".5").
  if (/^\d*\.?\d+$/.test(s)) return ok(Number(s), s)

  return { kind: "invalid", raw: s }
}

function ok(amount: number, raw: string): AuthoredAmount {
  if (!Number.isFinite(amount) || amount <= 0) return { kind: "invalid", raw }
  return { kind: "ok", amount }
}

/**
 * The amount to USE, or 0 when it cannot be trusted. An ambiguous value returns 0 on purpose —
 * a plan built from it must not validate, so the author is stopped rather than surprised.
 */
export function authoredAmountValue(parsed: AuthoredAmount): number {
  return parsed.kind === "ok" ? parsed.amount : 0
}
