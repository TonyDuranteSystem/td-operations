/**
 * Read-state rules for portal notifications (reactions job 5962e46d).
 *
 * Pure helpers, no DB / React, so the rules the bell, the notifications page and the
 * POST route share are unit-tested in one place.
 *
 * Why this exists: `read_at` used to be set ONLY by the two "Mark all read" buttons, so it
 * measured a button press, never whether the client saw anything. Tapping one item now marks
 * that one item read — except the types below, which ask the client to DO something and must
 * stay unread until the action is done (a signature, a form, a decision), or one tap would
 * clear the only persistent to-do marker the client has.
 */

import { localeFromLanguage, type Locale } from '@/lib/locale'

/** Notification types that ask the client to act. Never cleared by a tap or by "Mark all read". */
export const MUST_ACT_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'sign_document',
  'signature_request',
  'action_required',
  'action',
  'decision',
  'form_reminder_7d',
  'form_reminder_3d',
  'wizard_reminder',
])

export function isMustActNotification(type: string | null | undefined): boolean {
  return !!type && MUST_ACT_NOTIFICATION_TYPES.has(type)
}

export interface NotificationOwnerRow {
  id: string
  account_id: string | null
  contact_id: string | null
  type?: string | null
}

export type OwnershipCaller =
  | { kind: 'client'; contactId: string; accountIds: readonly string[] }
  | { kind: 'teammate'; accountId: string }

// A plain shape (not a discriminated union): the project's non-strict tsc does not narrow unions on `ok`.
export interface OwnershipDecision {
  ok: boolean
  status: 200 | 403 | 404
  error: string | null
}

/**
 * Every requested id must exist AND belong to the caller. Anything else rejects the whole batch
 * (the old check let a row with no account and someone else's contact through, and let unknown
 * ids pass silently).
 *
 * A client owns a row when it is on one of their companies, or when it is addressed to them
 * personally (contact = them and no company). A teammate owns only rows on their own company.
 */
export function decideNotificationOwnership(
  requestedIds: readonly string[],
  rows: readonly NotificationOwnerRow[],
  caller: OwnershipCaller,
): OwnershipDecision {
  const unique = Array.from(new Set(requestedIds))
  if (rows.length !== unique.length) {
    return { ok: false, status: 404, error: 'One or more notifications were not found.' }
  }
  for (const r of rows) {
    const owned =
      caller.kind === 'teammate'
        ? r.account_id === caller.accountId
        : (!!r.account_id && caller.accountIds.includes(r.account_id)) ||
          (!r.account_id && r.contact_id === caller.contactId)
    if (!owned) return { ok: false, status: 403, error: 'Access denied' }
  }
  return { ok: true, status: 200, error: null }
}

/** Split the requested rows into the ones a tap may clear and the must-act ones left unread. */
export function splitReadable<T extends { id: string; type?: string | null }>(
  rows: readonly T[],
): { markable: T[]; skipped: T[] } {
  const markable: T[] = []
  const skipped: T[] = []
  for (const r of rows) (isMustActNotification(r.type) ? skipped : markable).push(r)
  return { markable, skipped }
}

/** Longest message preview put in a reaction notification. */
export const REACTION_PREVIEW_MAX = 60

/** One-line preview of the message that was reacted to ("…" when cut, no half emoji). */
export function previewMessageText(text: string | null | undefined, max = REACTION_PREVIEW_MAX): string {
  const clean = (text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const chars = Array.from(clean)
  return chars.length <= max ? clean : `${chars.slice(0, max).join('').trimEnd()}…`
}

/**
 * Title + body of the "the team reacted to your message" notification, in the recipient's
 * language (chosen when the row is created — the row has nowhere to keep parameters).
 * `preview` is optional; without it the body names only the emoji.
 */
export function reactionNoticeText(
  language: string | Locale | null | undefined,
  emoji: string,
  preview: string,
): { title: string; body: string; pushBody: string } {
  const it = language === 'it' || (language !== 'en' && localeFromLanguage(language) === 'it')
  const title = it ? 'Nuova reazione dal Team Tony Durante' : 'New reaction from Tony Durante Team'
  const on = it ? 'sul tuo messaggio' : 'on your message'
  const body = preview ? `${emoji} ${on}: “${preview}”` : `${emoji} ${on}`
  // The lock screen shows only the emoji, never the text of the client's message.
  return { title, body, pushBody: `${emoji} ${on}` }
}

/** localStorage key holding when this person last looked at the chat of this company (per device). */
export function reactionSeenKey(accountId: string | null | undefined, contactId: string): string {
  return `td-reaction-seen:${accountId || 'personal'}:${contactId}`
}

export interface ReactionLike {
  reactor_type?: string
  created_at?: string
}

/**
 * True when a reaction on the viewer's OWN message should pulse: the team added it, and it arrived
 * after the last time the viewer looked. `seenAtMs` null = never looked on this device — then
 * only reactions from the last 14 days pulse, so a long-forgotten 👍 doesn't light up on a new phone.
 */
export function shouldPulseReaction(
  reaction: ReactionLike,
  seenAtMs: number | null,
  nowMs: number,
): boolean {
  if (reaction.reactor_type !== 'staff') return false
  const at = reaction.created_at ? Date.parse(reaction.created_at) : NaN
  if (!Number.isFinite(at)) return false
  const floor = seenAtMs ?? nowMs - 14 * 24 * 60 * 60 * 1000
  return at > floor
}
