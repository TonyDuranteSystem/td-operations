/**
 * Client iPhone app — the bottom bar (pure rules; dev job 056a70d0, Step 2).
 *
 * Decided with Antonio (8 Nov 2026): Chat is the only tab that always stays, the client picks the others, at most five tabs. The
 * Menu is a round button on every screen, not a tab. A new client starts with a STANDARD bar. The choice is saved with the login
 * and only ever shows what this person can really open today: an entry that stops being available drops out and the next standard
 * entry takes its place (the saved choice is NOT rewritten, so the entry comes back if it returns).
 *
 * Everything here is data in, data out: no database, no request. Keys are the portal menu keys of `lib/portal/nav-rules.ts`.
 */

export const APP_LOCKED_KEY = 'nav.chat'
export const APP_BAR_SIZE = 5
export const APP_FREE_TABS = APP_BAR_SIZE - 1

/** Menu entries that are not in the app at all (Antonio: "My Company" stays on the website). */
export const APP_EXCLUDED_KEYS: readonly string[] = ['nav.myCompany']

/**
 * The standard bar: the first five entries of a list that the person can open.
 * ACTIVE client (Antonio, 8 Nov 2026): Overview, Chat, Documents, Invoices, then TD Billing if TD has invoiced the client, otherwise
 * Sign Documents. A lead or a client still being set up has no company work yet, so their own first step (the proposal, or Complete
 * Setup) joins the list and nobody has to choose anything on day one. For an active client those two steps stay in the Menu: a
 * service wizard that happens to be open must not push Documents or Invoices out of the bar they were promised.
 */
export const STANDARD_BAR_PREFERENCE: readonly string[] = [
  'nav.overview',
  'nav.chat',
  'nav.offer',
  'nav.wizard',
  'nav.documents',
  'nav.invoices',
  'nav.tdBilling',
  'nav.signDocuments',
]

/** The tier whose standard bar is exactly Antonio's set (no first-step entries). */
export const ACTIVE_TIER = 'active'

export interface AppNavItem {
  key: string
  path: string
  label: string
  /** How many things are waiting in this entry (unread messages, documents to sign, unpaid invoices). 0 = none. */
  badge: number
}

export function standardBar(available: readonly string[], tier?: string | null): string[] {
  const have = new Set(available)
  const firstSteps = tier === ACTIVE_TIER ? ['nav.offer', 'nav.wizard'] : []
  return STANDARD_BAR_PREFERENCE.filter(k => have.has(k) && !firstSteps.includes(k)).slice(0, APP_BAR_SIZE)
}

/**
 * The bar this person sees now. `saved` is what they chose (null = never chose → the standard bar).
 * A saved bar keeps its own length: a deliberately short bar stays short; only an entry that DROPPED OUT is replaced.
 */
export function effectiveBar(saved: readonly string[] | null | undefined, available: readonly string[], tier?: string | null): string[] {
  const std = standardBar(available, tier)
  if (!saved || saved.length === 0) return std
  const have = new Set(available)
  const slots = Math.min(saved.length, APP_BAR_SIZE)
  const kept: string[] = []
  for (const k of saved) {
    if (typeof k !== 'string' || !have.has(k) || kept.includes(k)) continue
    if (kept.length < APP_BAR_SIZE) kept.push(k)
  }
  // Chat always stays (when this person has Chat at all).
  if (have.has(APP_LOCKED_KEY) && !kept.includes(APP_LOCKED_KEY)) {
    if (kept.length >= slots) kept.pop()
    kept.splice(Math.min(1, kept.length), 0, APP_LOCKED_KEY)
  }
  // Fill the slots left by entries that dropped out, from the standard bar.
  for (const k of std) {
    if (kept.length >= slots) break
    if (!kept.includes(k)) kept.push(k)
  }
  return kept.slice(0, APP_BAR_SIZE)
}

export type BarValidation = { ok: true; keys: string[] } | { ok: false; code: string; error: string }

const bad = (code: string, error: string): BarValidation => ({ ok: false, code, error })

/** Check a bar the app wants to save. Order is kept. The server never trusts the app: every key must be something this person can open. */
export function validateBar(input: unknown, available: readonly string[]): BarValidation {
  if (!Array.isArray(input)) return bad('BAR_INVALID', 'The bar must be a list.')
  if (input.length < 1 || input.length > APP_BAR_SIZE) return bad('BAR_SIZE', `The bar holds 1 to ${APP_BAR_SIZE} entries.`)
  const have = new Set(available)
  const keys: string[] = []
  for (const k of input) {
    if (typeof k !== 'string') return bad('BAR_INVALID', 'The bar must be a list of entry names.')
    if (APP_EXCLUDED_KEYS.includes(k) || !have.has(k)) return bad('BAR_NOT_AVAILABLE', 'One of those entries is not available to you.')
    if (keys.includes(k)) return bad('BAR_DUPLICATE', 'An entry can be in the bar only once.')
    keys.push(k)
  }
  if (have.has(APP_LOCKED_KEY) && !keys.includes(APP_LOCKED_KEY)) return bad('BAR_NEEDS_CHAT', 'Chat always stays in the bar.')
  return { ok: true, keys }
}

/**
 * What to store when the person saves `submitted` while looking at a company that can open `available`. The submitted list comes first.
 * Entries they chose earlier that THIS company cannot show (say TD Billing, picked while another company was open) are kept behind it
 * while there is room (at most five), so saving here does not erase the bar they set up elsewhere. An earlier entry this company CAN
 * show but the person left out was removed on purpose and is not kept.
 */
export function mergeBarChoice(submitted: readonly string[], previous: readonly string[] | null | undefined, available: readonly string[]): string[] {
  const have = new Set(available)
  const merged = [...submitted]
  for (const k of previous ?? []) {
    if (merged.length >= APP_BAR_SIZE) break
    if (typeof k !== 'string' || have.has(k) || merged.includes(k) || APP_EXCLUDED_KEYS.includes(k)) continue
    merged.push(k)
  }
  return merged.slice(0, APP_BAR_SIZE)
}

/** The number on the Menu button: what is waiting in the entries that are NOT in the bar. */
export function menuBadge(items: readonly AppNavItem[], bar: readonly string[]): number {
  const inBar = new Set(bar)
  return items.reduce((sum, i) => (inBar.has(i.key) ? sum : sum + Math.max(0, i.badge)), 0)
}
