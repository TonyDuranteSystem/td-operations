/**
 * Offer lists saved as TEXT instead of a real list (dev job 20600f18).
 *
 * An offer keeps its price breakdown, services, next steps and similar blocks as lists. One old offer
 * (March 2026) was saved with `cost_summary` and `services` as a JSON STRING that contains the list
 * (a caller sent the list pre-encoded, and nothing checked it). The staff pages did `.map` on it and
 * the whole contact page fell to the red "Errore di caricamento" screen.
 *
 * Two jobs, one place:
 *  - READ: `listOrEmpty` turns whatever is stored into a real list for display (never throws).
 *  - WRITE: `normalizeOfferLists` turns a pre-encoded list into a real list before it is saved, and
 *    refuses text that is not a list, so a new offer can never be stored this way.
 *
 * The client-facing offer and contract pages already parse these fields themselves; this is the same
 * rule for the staff side and for the door every offer is written through.
 */

/** The offer fields that are lists. Matches what `validateOfferJsonb` checks. */
export const OFFER_LIST_FIELDS = [
  "issues",
  "strategy",
  "services",
  "additional_services",
  "cost_summary",
  "recurring_costs",
  "future_developments",
  "next_steps",
  "immediate_actions",
] as const

/** A real list for display. A list stays as it is; a list saved as text is read; anything else is empty. Never throws. */
export function listOrEmpty<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

/** Flat on purpose (not a union on `ok`): this project is not strict, where a union on a boolean does not narrow. */
export interface NormalizeListsResult {
  ok: boolean
  /** The real lists to save in place of the text ones (empty when nothing needed fixing or when refused). */
  values: Record<string, unknown>
  /** Which fields were text and got fixed. */
  fixed: string[]
  /** Plain message when `ok` is false, else null. */
  error: string | null
}

/**
 * For the list fields present in `fields`: a list saved as text becomes the real list; a real list or an
 * empty value is left alone; text that does not read as a list is refused with a plain message.
 * Only touches the keys it is given (an update that does not mention a field never gets it added).
 * Returns the changed values and which fields were fixed — it never mutates `fields`.
 */
export function normalizeOfferLists(fields: Record<string, unknown>): NormalizeListsResult {
  const values: Record<string, unknown> = {}
  const fixed: string[] = []
  for (const key of OFFER_LIST_FIELDS) {
    if (!(key in fields)) continue
    const raw = fields[key]
    if (typeof raw !== "string") continue
    if (raw.trim() === "") continue
    const refused: NormalizeListsResult = { ok: false, values: {}, fixed: [], error: `${key} was sent as text that is not a list — send it as a real list.` }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return refused
    }
    if (!Array.isArray(parsed)) return refused
    values[key] = parsed
    fixed.push(key)
  }
  return { ok: true, values, fixed, error: null }
}
