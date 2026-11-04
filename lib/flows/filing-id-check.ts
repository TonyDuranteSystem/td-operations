/**
 * The "check the State Filing ID against the real document" step (dev job 64d2be64, Antonio 2026-11-04).
 *
 * The reader only PREFILLS the number; the card that shows it makes staff open the real document and either confirm the number or
 * correct it — or say the document carries none. The card, the formation upload window and the onboarding review screen all decide
 * from these pure functions, so the rules are written (and tested) once.
 */
import { normalizeFilingId } from "@/lib/articles-parse"

/** What staff chose on the card: "The number is correct", "There is no Filing ID on this document", or nothing yet. */
export type FilingIdDecision = "confirmed" | "none" | null

export interface FilingIdCheckResult {
  /** True once staff have made their call: a checked number, or "no Filing ID on this document". */
  resolved: boolean
  /** The tidied number to save. Null = save nothing (no call made yet, or staff said there is none). */
  filingId: string | null
}

export const FILING_ID_UNRESOLVED: FilingIdCheckResult = { resolved: false, filingId: null }

/** The outcome of the card for the number currently in its box and the choice staff made. */
export function filingIdCheckResult(input: { typed: string; decision: FilingIdDecision }): FilingIdCheckResult {
  if (input.decision === "none") return { resolved: true, filingId: null }
  if (input.decision === "confirmed") {
    const checked = normalizeFilingId(input.typed)
    if (checked) return { resolved: true, filingId: checked }
  }
  return FILING_ID_UNRESOLVED
}

/** Why "The number is correct" is locked right now, in plain words — or null when staff may press it. `viewed` = the document has really
 *  SHOWN (or was opened in a new tab); `opened` = the window was opened (it may still be loading, or unable to show the file). */
export function confirmLockReason(input: { typed: string; viewed: boolean; hasDocument: boolean; opened?: boolean }): string | null {
  if (input.hasDocument && !input.viewed) {
    return input.opened
      ? "The document has not shown yet. If this browser cannot show it, use “Open in a new tab” in the window's title bar."
      : "Open the real document first."
  }
  if (!input.typed.trim()) return "Type the number, or choose “There is no Filing ID on this document”."
  if (!normalizeFilingId(input.typed)) {
    return "The number can only contain letters, numbers and dashes (4 to 30 characters), for example 2026-002103965."
  }
  return null
}

/** Two numbers compared the way staff would: ignoring case, spaces and the dash kinds a PDF produces. */
export function sameFilingId(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeFilingId(a ?? "")
  const y = normalizeFilingId(b ?? "")
  return !!x && !!y && x === y
}

/**
 * What the onboarding setup saves as the company's State Filing ID. When staff checked the number on the review screen the job carries
 * it as `confirmed_filing_id` — a tidied number, or null for "this document has no Filing ID" (then nothing is saved, not even what the
 * client typed). A job queued without that key (an older one, or a submission with no Articles to check) falls back to the number the
 * client typed in the wizard, tidied the same way. Null = save nothing.
 */
export function resolveFilingIdToSave(payload: { confirmed_filing_id?: string | null }, submitted: Record<string, unknown>): string | null {
  if (payload.confirmed_filing_id !== undefined) return normalizeFilingId(payload.confirmed_filing_id)
  return normalizeFilingId(submitted.filing_id)
}

/** The text the client typed as the State Filing ID when nothing was checked by staff AND it cannot be a Filing ID ("N/A", "pending"…) — so
 *  the setup job can say it dropped it instead of dropping it silently. Null when staff checked a number, nothing was typed, or it is usable. */
export function unusableClientFilingId(payload: { confirmed_filing_id?: string | null }, submitted: Record<string, unknown>): string | null {
  if (payload.confirmed_filing_id !== undefined) return null
  const typed = typeof submitted.filing_id === "string" ? submitted.filing_id.trim() : ""
  if (!typed || normalizeFilingId(typed)) return null
  return typed.slice(0, 60)
}
