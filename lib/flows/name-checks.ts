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
  source: 'wizard' | 'client_resubmit' | 'client_suggestion' | 'staff_added'
  field?: string | null
  status: NameCheckStatus
  updated_at: string | null
  decision_request_id?: string | null
  sos_result?: string | null
  /** The client's free-text note when they rejected this proposed name. */
  note?: string | null
  /**
   * The company LEGAL name staff confirmed in the Articles upload window (the name exactly as printed on the Articles).
   * Saved on the FILED entry before the advance so every retry / stepper / tool path creates the same company name
   * (job 80cce1cb). Absent = the name is derived from `name` by the shared legal-name rule (lib/flows/legal-name.ts).
   */
  legal_name?: string | null
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

/** How a client's free-text answer is cut into names: every separator (the Formation default), or lines/semicolons only. */
export interface ParseNamesOptions {
  /**
   * 'all' (default, what Formation has always done): newlines, commas and semicolons.
   * 'lines': newlines and semicolons only — a comma is part of the name ("Acme Holdings, LLC").
   */
  separators?: 'all' | 'lines'
  /** Most names kept (default 5). */
  max?: number
}

/**
 * Parse a client's free-text "new names" response into a clean name list:
 * split on newlines / commas / semicolons (or only newlines / semicolons, see
 * `separators`), trim, drop empties, de-dupe (case-insensitive), cap at `max`
 * (default 5). Pure.
 */
export function parseProposedNames(text: unknown, options: ParseNamesOptions = {}): string[] {
  if (typeof text !== 'string') return []
  const splitter = options.separators === 'lines' ? /[\n;]+/ : /[\n,;]+/
  const max = Number.isInteger(options.max) && (options.max as number) > 0 ? (options.max as number) : 5
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(splitter)) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

/**
 * True when ONE entered name looks like several names run together ("Acme LLC, Acme Group LLC, Acme Capital LLC" on one
 * line): it carries more than one "LLC". Pure. A comma INSIDE one name ("Acme Holdings, LLC") has a single "LLC" and passes.
 */
export function looksLikeSeveralNames(name: string): boolean {
  return (name.match(/\bL\.?L\.?C\.?(?=\W|$)/gi) ?? []).length > 1
}

/**
 * Why a client's "send us your names" answer cannot be used, in plain words for the CLIENT, or null when it can. Run BEFORE
 * the answer is saved, so a useless answer is refused with a reason and the card stays open — instead of the card turning to
 * "Thank you" while nothing was added (production QA, 2026-10-20: a comma list became ONE name; names past the third were
 * dropped; re-typing a refused name added nothing). Pure.
 *   - nothing usable typed;
 *   - more names than the request allows;
 *   - a name over the length limit, or several names run together in one entry;
 *   - none of the names would be kept (every one is already on the list — dead names included).
 */
export type NamesProblemCode = 'empty' | 'too_many' | 'too_long' | 'run_together' | 'repeat'

export function namesAnswerProblemDetail(p: {
  text: unknown
  separators?: 'lines' | 'all'
  max?: number
  existing: readonly NameCheck[] | null | undefined
}): { code: NamesProblemCode; message: string } | null {
  const names = parseProposedNames(p.text, { separators: p.separators, max: 50 })
  if (names.length === 0) return { code: 'empty', message: 'Please enter at least one company name.' }
  const max = Number.isInteger(p.max) && (p.max as number) > 0 ? (p.max as number) : undefined
  if (max !== undefined && names.length > max) return { code: 'too_many', message: `Please send at most ${max} name${max === 1 ? '' : 's'}, one per line.` }
  if (names.some((n) => n.length > MAX_STAFF_NAME_LENGTH)) return { code: 'too_long', message: `A company name is too long (max ${MAX_STAFF_NAME_LENGTH} characters).` }
  if (names.some(looksLikeSeveralNames)) return { code: 'run_together', message: 'Please put each company name on its own line (or in its own box).' }
  const { added } = addClientNames(p.existing as NameCheck[] | null | undefined, names, '')
  if (added.length === 0) {
    return {
      code: 'repeat',
      message: names.length === 1
        ? 'That name is a repeat: it is on our list or was refused earlier. Please send a different name.'
        : 'Those names are repeats: they are on our list or were refused earlier. Please send different names.',
    }
  }
  return null
}

/** The same check, as the plain sentence only (null = the answer can be used). */
export function namesAnswerProblem(p: Parameters<typeof namesAnswerProblemDetail>[0]): string | null {
  return namesAnswerProblemDetail(p)?.message ?? null
}

/** Max length of one LLC name typed by staff (client messages interpolate it). */
export const MAX_STAFF_NAME_LENGTH = 120
/** Max candidates on one case — stops runaway lists. */
export const MAX_NAME_CANDIDATES = 30

/**
 * Comparison key for "is this the same LLC name": lowercased, punctuation and
 * extra spaces dropped, trailing LLC / L.L.C. / "limited liability company"
 * ignored — so "Acme", "ACME LLC" and "Acme L.L.C." are one name. Pure.
 */
export function nameDedupeKey(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*(limited liability company|llc)$/, '')
    .trim()
}

/**
 * Staff adds a candidate name directly (e.g. the client sent one by email or
 * chat). Appends a `pending` entry; rejects blank / too-long names and any
 * name that matches an existing one — dead names included, so a name that was
 * already refused can't come back through this door. Pure: returns a new array.
 */
export function addStaffName(
  checks: NameCheck[] | null | undefined,
  rawName: unknown,
  nowIso: string,
): { ok: boolean; checks?: NameCheck[]; error?: string } {
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : ''
  if (!name) return { ok: false, error: 'Type the LLC name to add.' }
  if (name.length > MAX_STAFF_NAME_LENGTH) {
    return { ok: false, error: `That name is too long (max ${MAX_STAFF_NAME_LENGTH} characters).` }
  }
  const list = Array.isArray(checks) ? checks : []
  if (list.length >= MAX_NAME_CANDIDATES) {
    return { ok: false, error: 'There are already too many names on this case.' }
  }
  const key = nameDedupeKey(name)
  if (!key) return { ok: false, error: 'Type the LLC name to add.' }
  if (list.some((c) => nameDedupeKey(c.name) === key)) {
    return { ok: false, error: 'That name is already on the list (or was already tried).' }
  }
  return {
    ok: true,
    checks: [...list, { name, source: 'staff_added', status: 'pending', updated_at: nowIso }],
  }
}

/**
 * Append names a CLIENT proposed (a "propose new names" answer). Unlike a plain
 * push, a name that matches an existing one — dead names included, by the same
 * `nameDedupeKey` staff-added names use — is skipped, so a refused name can't
 * come back through the client's answer either. Returns the new list plus the
 * names actually added. Pure.
 */
export function addClientNames(
  checks: NameCheck[] | null | undefined,
  names: readonly string[],
  nowIso: string,
): { checks: NameCheck[]; added: string[] } {
  const list = Array.isArray(checks) ? [...checks] : []
  const keys = new Set(list.map((c) => nameDedupeKey(c.name)))
  const added: string[] = []
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
    const key = nameDedupeKey(name)
    if (!name || !key || keys.has(key) || name.length > MAX_STAFF_NAME_LENGTH) continue
    if (list.length >= MAX_NAME_CANDIDATES) break
    keys.add(key)
    list.push({ name, source: 'client_resubmit', status: 'pending', updated_at: nowIso })
    added.push(name)
  }
  return { checks: list, added }
}

/**
 * The statuses each staff action may START from. The staff panel only ever
 * offers an action on a matching row, but the server used to apply any action
 * to any row — a stale tab or a hand-made request could send an unchecked name
 * to the client, re-mark a state-refused name "filed" (which also unlocks the
 * filed-name advance gate), or file a name the client never accepted.
 * `mark_sos_rejected` keeps its original rule (accepted or filed).
 */
export type GuardedNameAction =
  | 'mark_available'
  | 'mark_not_available'
  | 'send_to_client'
  | 'mark_filed'
  | 'mark_sos_rejected'
  | 'withdraw'

export const NAME_ACTION_FROM: Record<GuardedNameAction, readonly NameCheckStatus[]> = {
  mark_available: ['pending', 'not_available'],
  mark_not_available: ['pending', 'available'],
  send_to_client: ['available'],
  mark_filed: ['accepted'],
  mark_sos_rejected: ['accepted', 'filed'],
  withdraw: ['sent_to_client'],
}

const NAME_ACTION_PROBLEM: Record<GuardedNameAction, string> = {
  mark_available: 'Only a name that is still pending (or marked not available) can be marked available.',
  mark_not_available: 'Only a name that is pending (or available) can be marked not available.',
  send_to_client: 'Only a name marked available can be sent to the client.',
  mark_filed: 'Only a name the client accepted can be marked as filed.',
  mark_sos_rejected: 'Only a name the client accepted (or that was filed) can be marked as refused by the state.',
  withdraw: 'Only a name that is waiting for the client can be withdrawn.',
}

/** null when `action` may start from `status`, else a plain-English reason. Pure. */
export function nameActionProblem(action: GuardedNameAction, status: NameCheckStatus): string | null {
  const from = NAME_ACTION_FROM[action]
  // Not a guarded action (add_name / request_new_names, or an unknown one): the caller decides.
  if (!from) return null
  return from.includes(status) ? null : NAME_ACTION_PROBLEM[action]
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

/** The staff-confirmed legal name saved on the filed entry, or null (then the legal name is derived from the filed name). Pure. */
export function filedLegalName(checks: NameCheck[] | null | undefined): string | null {
  if (!Array.isArray(checks)) return null
  const filed = checks.find((c) => c.status === 'filed')
  return filed ? str(filed.legal_name) : null
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
 * candidate (filed > accepted > sent_to_client); only one is ever meant to be
 * actively progressing at a time, but nothing server-side currently stops
 * staff from sending TWO different candidates to the client before either is
 * answered. Returns null on a genuine tie (two DIFFERENT names at the same
 * top rank) rather than guessing which one the client is actually being
 * asked about — a wrong confident label is worse than the generic
 * placeholder (2026-09-11, senior-engineer council catch).
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
  let maxRank = 0
  const namesAtMaxRank = new Set<string>()
  for (const c of checks) {
    const rank = CONFIRMED_ENOUGH_RANK[c.status]
    if (!rank) continue
    const name = str(c.name)
    if (!name) continue
    if (rank > maxRank) {
      maxRank = rank
      namesAtMaxRank.clear()
      namesAtMaxRank.add(name)
    } else if (rank === maxRank) {
      namesAtMaxRank.add(name)
    }
  }
  // Array.from(), not a spread/for-of over the Set directly — this project's
  // TS target rejects iterating a Set without downlevelIteration (the exact
  // same trap team-workspace's 2026-09-05 entry already hit once).
  return namesAtMaxRank.size === 1 ? Array.from(namesAtMaxRank)[0] : null
}

/**
 * One name at a time (a service's `oneAtATime` rule, lib/flows/name-loop-policy.ts): true when a DIFFERENT name is already
 * with the client, accepted by them, or filed — so a second one must not be sent. The server refuses with this, and the
 * staff panel hides its "Send to Client" button with the same test, so the two can never disagree. Pure.
 */
export function anotherNameInProgress(checks: ReadonlyArray<Pick<NameCheck, 'status'>>, index: number): boolean {
  return checks.some((c, i) => i !== index && (c.status === 'sent_to_client' || c.status === 'accepted' || c.status === 'filed'))
}
