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
  // Only things that look like HTML tags are stripped ("x<5 and y>3" keeps its text).
  const clean = (text ?? '').replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  // Cut on whole characters as a person sees them (flags and family emoji are several code points).
  const chars: string[] =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean), x => x.segment)
      : Array.from(clean)
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

/** localStorage key holding which team reactions this person has actually looked at (per device). */
export function reactionSeenKey(accountId: string | null | undefined, contactId: string): string {
  return `td-reaction-seen:${accountId || 'personal'}:${contactId}`
}

export interface ReactionLike {
  reactor_type?: string
  created_at?: string
}

/** Identity of one reaction for "have I seen it": the message plus when it was added (re-adding makes a new one). */
export function reactionInstanceKey(messageId: string, reaction: ReactionLike): string {
  return `${messageId}|${reaction.created_at ?? ''}`
}

/** Most reaction keys remembered per device — enough for any real chat, small enough for localStorage. */
export const REACTION_SEEN_MAX = 200

/** Read the remembered keys back from localStorage text (anything unexpected → empty). */
export function parseSeenReactionKeys(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-REACTION_SEEN_MAX) : []
  } catch {
    return []
  }
}

/** Add keys, newest last, capped. */
export function addSeenReactionKeys(existing: readonly string[], add: readonly string[]): string[] {
  const merged = existing.slice()
  for (const k of add) if (!merged.includes(k)) merged.push(k)
  return merged.slice(-REACTION_SEEN_MAX)
}

/** Reactions older than this never pulse (a long-forgotten 👍 must not light up on a new phone). */
export const REACTION_PULSE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/**
 * True when a reaction on the viewer's OWN message should pulse: the team added it, it is recent, and the
 * viewer has not yet actually had it on screen on this device (`seenKeys`).
 */
export function shouldPulseReaction(
  reaction: ReactionLike,
  messageId: string,
  seenKeys: ReadonlySet<string>,
  nowMs: number,
): boolean {
  if (reaction.reactor_type !== 'staff') return false
  const at = reaction.created_at ? Date.parse(reaction.created_at) : NaN
  if (!Number.isFinite(at)) return false
  if (nowMs - at > REACTION_PULSE_WINDOW_MS) return false
  return !seenKeys.has(reactionInstanceKey(messageId, reaction))
}
