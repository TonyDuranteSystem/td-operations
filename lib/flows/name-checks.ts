/**
 * Formation Name Command Center — pure helpers + types for the per-name status
 * tracking stored in `service_deliveries.name_checks` (JSONB). Pure (no I/O) so
 * the init + parse logic is unit-tested and shared by the server helper
 * (lib/operations/formation-name-checks.ts) and the client component
 * (components/flows/formation-names.tsx).
 *
 * Status lifecycle:
 *   pending → available | not_available
 *   available → sent_to_client (an approval decision request is created)
 *   sent_to_client → accepted | rejected_by_client (client's response)
 *   accepted → filed (staff files on SOS)
 *   filed → rejected_by_sos (SOS rejects; a text_input request for new names fires)
 * New names the client proposes append as fresh `pending` entries (source
 * 'client_resubmit').
 *
 * Invariant (2026-09-10, Lead Lift LLC incident): a client-facing "propose new
 * names" (text_input) request may only be created while `allNamesDead()` is
 * true, and is retracted the instant `send_to_client` puts a candidate back in
 * front of the client — never left pending after the underlying ask is moot.
 * See lib/operations/formation-name-checks.ts.
 */

export type NameCheckStatus =
  | 'pending'
  | 'available'
  | 'not_available'
  | 'sent_to_client'
  | 'accepted'
  | 'rejected_by_client'
  | 'filed'
  | 'rejected_by_sos'

export interface NameCheck {
  name: string
  source: 'wizard' | 'client_resubmit' | 'client_suggestion'
  field?: string | null
  status: NameCheckStatus
  updated_at: string | null
  decision_request_id?: string | null
  sos_result?: string | null
  /** The client's free-text note when they rejected this proposed name. */
  note?: string | null
}

/** Display metadata per status (label + emoji) for the staff panel + badges. */
export const NAME_STATUS_META: Record<NameCheckStatus, { label: string; emoji: string }> = {
  pending: { label: 'Pending', emoji: '•' },
  available: { label: 'Available', emoji: '✅' },
  not_available: { label: 'Not available', emoji: '⛔' },
  sent_to_client: { label: 'Waiting for client', emoji: '⏳' },
  accepted: { label: 'Accepted by client', emoji: '✅' },
  rejected_by_client: { label: 'Client rejected', emoji: '❌' },
  filed: { label: 'Filed with SOS', emoji: '📄' },
  rejected_by_sos: { label: 'Rejected by SOS', emoji: '🚫' },
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/**
 * Build the initial name_checks array from a formation wizard `data` blob.
 * Prefers the numbered candidates (llc_name_1/2/3); falls back to a single
 * legacy name field. Empty slots are skipped. Pure.
 */
export function initNameChecksFromWizard(data: Record<string, unknown> | null | undefined): NameCheck[] {
  if (!data || typeof data !== 'object') return []
  const out: NameCheck[] = []
  for (const field of ['llc_name_1', 'llc_name_2', 'llc_name_3']) {
    const name = str(data[field])
    if (name) out.push({ name, source: 'wizard', field, status: 'pending', updated_at: null })
  }
  if (out.length === 0) {
    for (const field of ['llc_name', 'company_name', 'business_name']) {
      const name = str(data[field])
      if (name) {
        out.push({ name, source: 'wizard', field, status: 'pending', updated_at: null })
        break
      }
    }
  }
  return out
}

/**
 * Parse a client's free-text "new names" response into a clean name list:
 * split on newlines / commas / semicolons, trim, drop empties, de-dupe
 * (case-insensitive), cap at 5. Pure.
 */
export function parseProposedNames(text: unknown): string[] {
  if (typeof text !== 'string') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\n,;]+/)) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 5) break
  }
  return out
}

/** True when at least one name has been filed with the SOS (advance gate). */
export function hasFiledName(checks: NameCheck[] | null | undefined): boolean {
  return Array.isArray(checks) && checks.some((c) => c.status === 'filed')
}

/**
 * True only when every candidate is in a dead-end status (not_available /
 * rejected_by_client / rejected_by_sos) — the sole precondition for asking the
 * client for a fresh set of names. An empty list is deliberately NOT "all
 * dead": there is nothing to have died yet (a bare `.every()` on `[]` is
 * vacuously true in JS, which would wrongly let the ask through for a client
 * who hasn't even submitted names). The single source of truth for this
 * check — consumed by the staff panel's button visibility AND the server-side
 * guard on both request_new_names and mark_sos_rejected, so the three can
 * never drift apart the way they did before the 2026-09-10 fix.
 */
export function allNamesDead(checks: NameCheck[] | null | undefined): boolean {
  if (!Array.isArray(checks) || checks.length === 0) return false
  return checks.every((c) => c.status === 'not_available' || c.status === 'rejected_by_client' || c.status === 'rejected_by_sos')
}

/**
 * The confirmed company name — the candidate filed with the Secretary of State
 * (status 'filed'). This is the real LLC name once the state approves it, used
 * for the "Company Created" milestone banner. Returns null when no name has been
 * filed yet (or input is empty/invalid). Pure.
 */
export function filedName(checks: NameCheck[] | null | undefined): string | null {
  if (!Array.isArray(checks)) return null
  const filed = checks.find((c) => c.status === 'filed')
  return filed ? str(filed.name) : null
}

const CONFIRMED_ENOUGH_RANK: Partial<Record<NameCheckStatus, number>> = {
  sent_to_client: 1,
  accepted: 2,
  filed: 3,
}

/**
 * The name to show the CLIENT on their own portal before the company is
 * materialized — real enough to display once staff has put it in front of
 * them (sent_to_client), not while it's still just one of several candidates
 * being checked (pending/available/not_available) or a dead one
 * (rejected_by_client/rejected_by_sos). Prefers the most-advanced qualifying
 * candidate (filed > accepted > sent_to_client); only one is ever actively
 * progressing in practice, but ties are broken deterministically rather than
 * left to array order.
 *
 * Added 2026-09-11 (dev job cb771564, bug-hunter catch during the old
 * name-picker retirement): the retired contact-page tool was the only writer
 * of `wizard_progress.data.chosen_name_final` — the field
 * `getInProgressFormations()` (lib/portal/queries.ts) used to show this same
 * name pre-materialization. Removing that writer without adding this
 * replacement would have silently regressed every in-progress formation's
 * client-facing label to a generic placeholder — confirmed live: it already
 * had, for one real production client, before this fix.
 */
export function confirmedClientFacingName(checks: NameCheck[] | null | undefined): string | null {
  if (!Array.isArray(checks)) return null
  let best: { name: string; rank: number } | null = null
  for (const c of checks) {
    const rank = CONFIRMED_ENOUGH_RANK[c.status]
    if (!rank) continue
    const name = str(c.name)
    if (!name) continue
    if (!best || rank > best.rank) best = { name, rank }
  }
  return best?.name ?? null
}
