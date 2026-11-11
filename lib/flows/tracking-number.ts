/**
 * Is this plausibly a tracking number? (production end-to-end test 2026-11-10, finding F7: "abc" was saved as the IRS mailing's tracking number and
 * satisfied the step's tracking lock, so the job could move on with nothing to track.)
 *
 * The staff screen saves the number of the package TD mails to the IRS with a US courier, and a daily check reads that number from the courier's site.
 * A wrong shape is refused with a sentence that says what the courier's numbers look like; "Other" (any other courier, a postal service abroad…) only
 * needs to be a believable reference. The shapes are deliberately generous (several real formats per courier) — this catches typing mistakes and
 * a number picked under the wrong courier, not unusual-but-real numbers; for those the person can choose "Other".
 *
 * Spaces and dashes typed inside a number are ignored when checking. Pure — no I/O.
 */

const ALNUM = /^[A-Za-z0-9]+$/

/** Sentence per courier: what its numbers look like. */
const SHAPE_HELP: Record<string, string> = {
  USPS: "USPS tracking numbers are 20–22 digits (for example 9400…), or 13 characters like EA123456789US for international mail",
  UPS: "UPS tracking numbers start with 1Z and have 18 characters (for example 1Z999AA10123456784)",
  FedEx: "FedEx tracking numbers are 12, 15, 20 or 22 digits",
  DHL: "DHL tracking numbers are 10 or 11 digits (Express), or letters followed by digits (for example JJD01234567890)",
}

function shapeOk(courier: string, n: string): boolean {
  switch (courier) {
    case "USPS":
      return /^\d{20,26}$/.test(n) || /^[A-Za-z]{2}\d{9}[A-Za-z]{2}$/.test(n)
    case "UPS":
      return /^1Z[0-9A-Za-z]{16}$/i.test(n) || /^T\d{10}$/i.test(n) || /^\d{9}$/.test(n) || /^\d{12}$/.test(n)
    case "FedEx":
      return /^\d{12}$/.test(n) || /^\d{15}$/.test(n) || /^\d{20}$/.test(n) || /^\d{22}$/.test(n) || /^\d{34}$/.test(n)
    case "DHL":
      return /^\d{10,11}$/.test(n) || /^[A-Za-z]{2,4}\d{8,20}$/.test(n)
    default:
      return true
  }
}

/** `null` when the number is acceptable, else a plain sentence for staff. */
export function trackingNumberProblem(courier: string, raw: string): string | null {
  const n = String(raw ?? "").replace(/[\s-]+/g, "")
  if (!n) return "Please enter a tracking number."
  if (!ALNUM.test(n)) return "A tracking number has only letters and digits — check it for a stray character."
  if (n.length < 8) return `"${raw.trim()}" is too short to be a tracking number (at least 8 characters) — check the label.`
  if ((n.match(/\d/g) ?? []).length < 6) return `"${raw.trim()}" does not look like a tracking number (it has almost no digits) — check the label.`
  if (/^(.)\1+$/.test(n)) return `"${raw.trim()}" does not look like a real tracking number — check the label.`
  if (!shapeOk(courier, n)) {
    const help = SHAPE_HELP[courier]
    return `"${raw.trim()}" does not look like a ${courier} tracking number${help ? `. ${help}` : ""}. Check the number and the courier — or choose "Other" if it really is another carrier's number.`
  }
  return null
}
