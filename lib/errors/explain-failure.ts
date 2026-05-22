/**
 * explainFailure — turn a real system error into a plain-language reason.
 *
 * Philosophy (agreed 2026-05-21): we do NOT maintain a separate predictive list
 * of everything that could go wrong (that drifts the moment the system changes).
 * Instead we READ the failure the system actually produced — the database, a
 * validation, a guard — and translate it. Because it reacts to the live system's
 * own enforcement, it can never fall out of sync with the schema.
 *
 * Two layers:
 *   1. A generic floor keyed on the Postgres error CODE (always current — these
 *      codes are part of the database engine, not our business logic).
 *   2. A small, optional override map for specific constraints where a friendlier,
 *      more actionable wording helps. Overrides are pure polish — if one is missing,
 *      the generic floor still gives a usable message.
 *
 * The generic layer needs no maintenance when the system changes. Only the
 * override map is hand-written, and it degrades gracefully.
 */

export interface ExplainedFailure {
  /** Plain-language, user-facing reason. */
  message: string
  /** The raw technical error, preserved for logs / "show details". */
  technical: string
}

interface PgLikeError {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

/**
 * Friendlier wording for specific constraints. Optional — the generic floor
 * covers anything not listed here. Add an entry only when the generic message
 * isn't actionable enough for a common case.
 */
const KNOWN_CONSTRAINTS: Record<string, string> = {
  uq_members_account_contact: 'That person is already a member of this company. Each contact can only be added as a member once.',
}

/** Pull `constraint "name"` out of a Postgres error message/details. */
export function extractConstraintName(text: string): string | null {
  const m = /constraint ["']([^"']+)["']/i.exec(text)
  return m ? m[1] : null
}

/** Pull `column "name"` out of a Postgres error message. */
export function extractColumnName(text: string): string | null {
  const m = /column ["']([^"']+)["']/i.exec(text)
  return m ? m[1].replace(/_/g, ' ') : null
}

export function explainFailure(err: unknown): ExplainedFailure {
  const e = (err ?? {}) as PgLikeError
  const technical = (typeof e.message === 'string' && e.message) ? e.message : String(err)
  const code = e.code ?? ''
  const haystack = `${technical} ${e.details ?? ''}`

  // Layer 2: friendlier wording for a known constraint, if we have one.
  const constraint = extractConstraintName(haystack)
  if (constraint && KNOWN_CONSTRAINTS[constraint]) {
    return { message: KNOWN_CONSTRAINTS[constraint], technical }
  }

  // Layer 1: generic floor by Postgres error code — always current.
  switch (code) {
    case '23505': // unique_violation
      return { message: 'This looks like a duplicate — a matching record already exists.', technical }
    case '23502': { // not_null_violation
      const col = extractColumnName(haystack)
      return { message: col ? `A required field is missing: ${col}.` : 'A required field is missing.', technical }
    }
    case '23503': // foreign_key_violation
      return { message: 'This refers to something that doesn’t exist yet — a linked record is missing. Create or fix that first.', technical }
    case '23514': // check_violation
      return { message: 'One of the values isn’t allowed here. Please check the entry and try again.', technical }
    case '23P01': // exclusion_violation
      return { message: 'This conflicts with an existing record.', technical }
    default:
      // Unknown / non-DB error: surface the real message rather than hide it (R099),
      // with a sane fallback when there's nothing useful.
      return {
        message: technical && technical !== '[object Object]' ? technical : 'Something went wrong and the action couldn’t be completed.',
        technical,
      }
  }
}
